#!/usr/bin/env python3
"""
Depth Anything V2 - Monocular Depth Estimation

Usage:
    python depth_anything.py --input_dir <images_folder> --output_dir <depth_folder>
    python depth_anything.py --input_dir <images_folder> --output_dir <depth_folder> --model small

Outputs depth maps as 16-bit PNG files (for precision) and normalized 8-bit PNGs for visualization.
"""

import argparse
import os
import sys
import json
from pathlib import Path

import numpy as np
from PIL import Image
import torch
from tqdm import tqdm


def setup_model(model_size: str = "small"):
    """
    Load Depth Anything V2 model from HuggingFace using AutoModel
    (avoids torchvision dependency issues)
    
    Model sizes:
    - small: ~25M params, fastest
    - base: ~98M params, balanced
    - large: ~335M params, best quality
    """
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    
    model_map = {
        "small": "depth-anything/Depth-Anything-V2-Small-hf",
        "base": "depth-anything/Depth-Anything-V2-Base-hf", 
        "large": "depth-anything/Depth-Anything-V2-Large-hf"
    }
    
    model_name = model_map.get(model_size, model_map["small"])
    
    # Determine device
    if torch.cuda.is_available():
        device = torch.device("cuda")
        print(f"Using CUDA GPU: {torch.cuda.get_device_name(0)}", file=sys.stderr)
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        device = torch.device("mps")
        print("Using Apple Metal GPU", file=sys.stderr)
    else:
        device = torch.device("cpu")
        print("Using CPU (this will be slow)", file=sys.stderr)
    
    print(f"Loading Depth Anything V2 ({model_size})...", file=sys.stderr)
    
    # Load model and processor directly (avoids pipeline torchvision issues)
    processor = AutoImageProcessor.from_pretrained(model_name)
    model = AutoModelForDepthEstimation.from_pretrained(model_name)
    model = model.to(device)
    model.eval()
    
    return {"model": model, "processor": processor, "device": device}


def estimate_depth(model_dict: dict, image_path: Path) -> tuple[np.ndarray, dict]:
    """
    Run depth estimation on a single image
    
    Returns:
        depth_map: numpy array of depth values (float32, metric scale)
        metadata: dict with image info
    """
    model = model_dict["model"]
    processor = model_dict["processor"]
    device = model_dict["device"]
    
    image = Image.open(image_path).convert("RGB")
    
    # Prepare input
    inputs = processor(images=image, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    
    # Run inference
    with torch.no_grad():
        outputs = model(**inputs)
        predicted_depth = outputs.predicted_depth
    
    # Interpolate to original size
    prediction = torch.nn.functional.interpolate(
        predicted_depth.unsqueeze(1),
        size=image.size[::-1],  # (height, width)
        mode="bicubic",
        align_corners=False,
    )
    
    # Convert to numpy
    depth = prediction.squeeze().cpu().numpy()
    
    # Normalize to 0-1 range for storage
    depth_min = depth.min()
    depth_max = depth.max()
    depth_normalized = (depth - depth_min) / (depth_max - depth_min + 1e-8)
    
    metadata = {
        "width": image.width,
        "height": image.height,
        "depth_min": float(depth_min),
        "depth_max": float(depth_max),
        "source": str(image_path.name)
    }
    
    return depth_normalized, metadata


def save_depth(depth: np.ndarray, output_path: Path, save_vis: bool = True):
    """
    Save depth map as 16-bit PNG for precision
    Optionally save 8-bit visualization
    """
    # Convert to 16-bit for precision
    depth_16bit = (depth * 65535).astype(np.uint16)
    depth_image = Image.fromarray(depth_16bit, mode='I;16')
    depth_image.save(output_path)
    
    # Save visualization (8-bit, inverted for viewing)
    if save_vis:
        vis_path = output_path.with_suffix('.vis.png')
        # Invert so closer = brighter (more intuitive)
        depth_vis = ((1.0 - depth) * 255).astype(np.uint8)
        Image.fromarray(depth_vis, mode='L').save(vis_path)


def process_directory(
    input_dir: Path,
    output_dir: Path,
    model_size: str = "small",
    save_vis: bool = True
) -> dict:
    """
    Process all images in a directory
    
    Returns summary with metadata for all processed images
    """
    # Find all images
    image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
    images = [
        f for f in input_dir.iterdir() 
        if f.is_file() and f.suffix.lower() in image_extensions
    ]
    
    if not images:
        raise ValueError(f"No images found in {input_dir}")
    
    print(f"Found {len(images)} images to process", file=sys.stderr)
    
    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Load model
    model_dict = setup_model(model_size)
    
    # Process each image
    results = []
    for image_path in tqdm(images, desc="Estimating depth"):
        try:
            depth, metadata = estimate_depth(model_dict, image_path)
            
            # Save depth map
            output_path = output_dir / f"{image_path.stem}_depth.png"
            save_depth(depth, output_path, save_vis=save_vis)
            
            metadata["output_file"] = str(output_path.name)
            results.append(metadata)
            
        except Exception as e:
            print(f"Error processing {image_path.name}: {e}", file=sys.stderr)
            results.append({
                "source": str(image_path.name),
                "error": str(e)
            })
    
    # Save summary
    device = model_dict["device"]
    summary = {
        "model": model_size,
        "total_images": len(images),
        "successful": len([r for r in results if "error" not in r]),
        "images": results,
        "device_type": "gpu" if device.type in ['cuda', 'mps'] else "cpu",
        "device_name": torch.cuda.get_device_name(0) if device.type == 'cuda' else device.type.upper()
    }
    
    summary_path = output_dir / "depth_summary.json"
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    
    return summary


def main():
    parser = argparse.ArgumentParser(description="Depth Anything V2 depth estimation")
    parser.add_argument("--input_dir", type=str, required=True, help="Directory containing images")
    parser.add_argument("--output_dir", type=str, required=True, help="Directory for depth maps")
    parser.add_argument("--model", type=str, default="small", choices=["small", "base", "large"],
                       help="Model size (default: small)")
    parser.add_argument("--no-vis", action="store_true", help="Don't save visualization images")
    parser.add_argument("--json", action="store_true", help="Output summary as JSON to stdout")
    
    args = parser.parse_args()
    
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    
    if not input_dir.exists():
        print(f"Error: Input directory does not exist: {input_dir}", file=sys.stderr)
        sys.exit(1)
    
    try:
        summary = process_directory(
            input_dir=input_dir,
            output_dir=output_dir,
            model_size=args.model,
            save_vis=not args.no_vis
        )
        
        if args.json:
            print(json.dumps(summary))
        else:
            print(f"\nProcessed {summary['successful']}/{summary['total_images']} images")
            print(f"Depth maps saved to: {output_dir}")
            
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
