#!/usr/bin/env python3
"""
Semantic Segmentation for Text-Based Splat Selection

Uses Grounding DINO for open-vocabulary detection + SAM2 for precise masks.

Usage:
    python semantic_segment.py --input_dir <images_folder> --prompt "bike" --output_dir <masks_folder>
    python semantic_segment.py --input_dir <images_folder> --prompt "red car" --json

Outputs binary masks as PNG files (1 = selected, 0 = background).
"""

import argparse
import os
import sys
import json
import base64
from pathlib import Path
from io import BytesIO
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

import numpy as np
from PIL import Image
import torch
from tqdm import tqdm


class SegmentationBackend(ABC):
    """Abstract base for segmentation backends (local or cloud)"""
    
    @abstractmethod
    def segment(self, image: Image.Image, prompt: str) -> Optional[np.ndarray]:
        """
        Segment objects matching prompt in the image.
        
        Returns:
            Binary mask (H, W) where 1 = selected region, 0 = background
            None if no objects found
        """
        pass
    
    @abstractmethod
    def load_models(self) -> None:
        """Load required models"""
        pass


class LocalGroundingSAMBackend(SegmentationBackend):
    """Local inference using Grounding DINO + SAM"""
    
    def __init__(self, device: torch.device, box_threshold: float = 0.25, text_threshold: float = 0.25):
        self.device = device
        self.box_threshold = box_threshold
        self.text_threshold = text_threshold
        self.grounding_processor = None
        self.grounding_model = None
        self.sam_processor = None
        self.sam_model = None
    
    def load_models(self) -> None:
        from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
        from transformers import SamModel, SamProcessor
        
        print("Loading Grounding DINO...", file=sys.stderr)
        self.grounding_processor = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
        self.grounding_model = AutoModelForZeroShotObjectDetection.from_pretrained(
            "IDEA-Research/grounding-dino-base"
        ).to(self.device)
        self.grounding_model.eval()
        
        print("Loading SAM...", file=sys.stderr)
        self.sam_processor = SamProcessor.from_pretrained("facebook/sam-vit-base")
        self.sam_model = SamModel.from_pretrained("facebook/sam-vit-base").to(self.device)
        self.sam_model.eval()
        
        print("Models loaded successfully", file=sys.stderr)
    
    def segment(self, image: Image.Image, prompt: str) -> Optional[np.ndarray]:
        if self.grounding_model is None:
            raise RuntimeError("Models not loaded. Call load_models() first.")
        
        # Step 1: Detect objects with Grounding DINO
        # Add period to prompt if not present (required by Grounding DINO)
        text_prompt = prompt if prompt.endswith('.') else prompt + '.'
        
        inputs = self.grounding_processor(images=image, text=text_prompt, return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        
        with torch.no_grad():
            outputs = self.grounding_model(**inputs)
        
        # Post-process detections
        results = self.grounding_processor.post_process_grounded_object_detection(
            outputs,
            inputs["input_ids"],
            box_threshold=self.box_threshold,
            text_threshold=self.text_threshold,
            target_sizes=[image.size[::-1]]  # (height, width)
        )[0]
        
        boxes = results["boxes"]
        
        if len(boxes) == 0:
            return None
        
        # Step 2: Generate masks with SAM for each detected box
        # Convert boxes to the format SAM expects
        boxes_list = boxes.cpu().numpy().tolist()
        
        # SAM expects boxes as [[x1, y1, x2, y2], ...]
        sam_inputs = self.sam_processor(
            image,
            input_boxes=[boxes_list],
            return_tensors="pt"
        )
        sam_inputs = {k: v.to(self.device) for k, v in sam_inputs.items()}
        
        with torch.no_grad():
            sam_outputs = self.sam_model(**sam_inputs)
        
        # Get masks and combine them
        masks = self.sam_processor.image_processor.post_process_masks(
            sam_outputs.pred_masks.cpu(),
            sam_inputs["original_sizes"].cpu(),
            sam_inputs["reshaped_input_sizes"].cpu()
        )[0]
        
        # Combine all masks into a single binary mask
        # masks shape: (num_boxes, num_predictions_per_box, H, W)
        # Take the best prediction for each box (index 0) and union all
        combined_mask = torch.zeros(masks.shape[-2:], dtype=torch.bool)
        for i in range(masks.shape[0]):
            # Take the highest confidence mask prediction (usually index 0)
            combined_mask = combined_mask | masks[i, 0].bool()
        
        return combined_mask.numpy().astype(np.uint8)


def get_device(force_cpu: bool = False) -> torch.device:
    """Determine the best available device"""
    if force_cpu:
        print("Forcing CPU mode", file=sys.stderr)
        return torch.device("cpu")
    
    if torch.cuda.is_available():
        device = torch.device("cuda")
        print(f"Using CUDA GPU: {torch.cuda.get_device_name(0)}", file=sys.stderr)
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        device = torch.device("mps")
        print("Using Apple Metal GPU", file=sys.stderr)
    else:
        device = torch.device("cpu")
        print("Using CPU (this will be slower)", file=sys.stderr)
    return device


def mask_to_base64(mask: np.ndarray) -> str:
    """Convert binary mask to base64-encoded PNG"""
    # Convert to PIL Image (0 or 255 for visibility)
    mask_img = Image.fromarray((mask * 255).astype(np.uint8), mode='L')
    
    # Save to bytes
    buffer = BytesIO()
    mask_img.save(buffer, format='PNG', optimize=True)
    
    return base64.b64encode(buffer.getvalue()).decode('utf-8')


def process_images(
    input_dir: Path,
    prompt: str,
    backend: SegmentationBackend,
    output_dir: Optional[Path] = None,
    return_json: bool = False
) -> Dict[str, Any]:
    """
    Process all images in directory and generate masks.
    
    Args:
        input_dir: Directory containing input images
        prompt: Text prompt describing what to segment
        backend: Segmentation backend to use
        output_dir: Optional directory to save mask PNGs
        return_json: If True, include base64 masks in result
    
    Returns:
        Dictionary with processing results
    """
    # Find all images
    image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
    image_files = sorted([
        f for f in input_dir.iterdir()
        if f.suffix.lower() in image_extensions
    ])
    
    if not image_files:
        raise ValueError(f"No images found in {input_dir}")
    
    print(f"Processing {len(image_files)} images with prompt: '{prompt}'", file=sys.stderr)
    
    # Load models
    backend.load_models()
    
    results = {
        "prompt": prompt,
        "images_processed": 0,
        "images_with_detections": 0,
        "masks": []
    }
    
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
    
    for img_path in tqdm(image_files, desc="Segmenting", file=sys.stderr):
        image = Image.open(img_path).convert("RGB")
        
        mask = backend.segment(image, prompt)
        
        mask_info = {
            "filename": img_path.name,
            "width": image.width,
            "height": image.height,
            "has_detection": mask is not None
        }
        
        if mask is not None:
            results["images_with_detections"] += 1
            
            # Count selected pixels
            mask_info["selected_pixels"] = int(mask.sum())
            mask_info["total_pixels"] = mask.size
            mask_info["coverage"] = float(mask.sum() / mask.size)
            
            if output_dir:
                # Save mask as PNG
                mask_path = output_dir / f"{img_path.stem}_mask.png"
                mask_img = Image.fromarray((mask * 255).astype(np.uint8), mode='L')
                mask_img.save(mask_path)
                mask_info["mask_path"] = str(mask_path)
            
            if return_json:
                mask_info["mask_base64"] = mask_to_base64(mask)
        
        results["masks"].append(mask_info)
        results["images_processed"] += 1
    
    return results


def main():
    parser = argparse.ArgumentParser(description="Semantic segmentation for splat selection")
    parser.add_argument("--input_dir", required=True, help="Directory containing input images")
    parser.add_argument("--prompt", required=True, help="Text prompt describing what to segment")
    parser.add_argument("--output_dir", help="Directory to save mask PNGs")
    parser.add_argument("--json", action="store_true", help="Output results as JSON with base64 masks")
    parser.add_argument("--box_threshold", type=float, default=0.25, help="Detection confidence threshold")
    parser.add_argument("--text_threshold", type=float, default=0.25, help="Text matching threshold")
    parser.add_argument("--cpu", action="store_true", help="Force CPU mode (useful if GPU has compatibility issues)")
    
    args = parser.parse_args()
    
    input_dir = Path(args.input_dir)
    if not input_dir.exists():
        print(f"Error: Input directory does not exist: {input_dir}", file=sys.stderr)
        sys.exit(1)
    
    output_dir = Path(args.output_dir) if args.output_dir else None
    
    def run_with_device(force_cpu: bool):
        device = get_device(force_cpu=force_cpu)
        backend = LocalGroundingSAMBackend(
            device=device,
            box_threshold=args.box_threshold,
            text_threshold=args.text_threshold
        )
        
        return process_images(
            input_dir=input_dir,
            prompt=args.prompt,
            backend=backend,
            output_dir=output_dir,
            return_json=args.json
        )
    
    try:
        results = run_with_device(force_cpu=args.cpu)
        
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            print(f"\nProcessed {results['images_processed']} images")
            print(f"Detections found in {results['images_with_detections']} images")
            if output_dir:
                print(f"Masks saved to: {output_dir}")
        
    except RuntimeError as e:
        # Check for CUDA compatibility errors and fall back to CPU
        error_msg = str(e).lower()
        if not args.cpu and ('cuda' in error_msg or 'no kernel image' in error_msg):
            print("\n⚠ CUDA error detected - your GPU may not be supported by current PyTorch version", file=sys.stderr)
            print("Falling back to CPU mode...\n", file=sys.stderr)
            
            # Clear GPU memory before CPU fallback
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            
            try:
                results = run_with_device(force_cpu=True)
                
                if args.json:
                    print(json.dumps(results, indent=2))
                else:
                    print(f"\nProcessed {results['images_processed']} images")
                    print(f"Detections found in {results['images_with_detections']} images")
                    if output_dir:
                        print(f"Masks saved to: {output_dir}")
            except Exception as cpu_e:
                print(f"Error (CPU fallback): {cpu_e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                sys.exit(1)
        else:
            raise
            
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
