#!/usr/bin/env python3
"""
DISK + LightGlue feature extraction and matching for COLMAP

This script extracts learned features using DISK and matches them
using LightGlue, then imports them into a COLMAP database for use in
Structure from Motion reconstruction.

DISK is a learned local feature detector that provides better results
than traditional SIFT for many challenging scenes (low texture,
repetitive patterns, lighting variations).

Requires: kornia, opencv-python
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
from tqdm import tqdm

# Suppress warnings
import warnings
warnings.filterwarnings("ignore")


def get_device(force_cpu: bool = False):
    """Determine the best available device"""
    if force_cpu:
        print("Using CPU (forced)", file=sys.stderr)
        return torch.device("cpu")
    
    if torch.cuda.is_available():
        device = torch.device("cuda")
        gpu_name = torch.cuda.get_device_name(0)
        print(f"Using CUDA GPU: {gpu_name}", file=sys.stderr)
        
        # Check if this is a very new GPU that might not be supported
        # RTX 50xx series (Blackwell) may not have kernels in older PyTorch
        if "5080" in gpu_name or "5090" in gpu_name or "5070" in gpu_name:
            print("Warning: RTX 50xx detected - may need newer PyTorch for full support", file=sys.stderr)
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        device = torch.device("mps")
        print("Using Apple Metal GPU", file=sys.stderr)
    else:
        device = torch.device("cpu")
        print("Using CPU (this will be slower)", file=sys.stderr)
    return device


def setup_models(device: torch.device, max_keypoints: int = 2048):
    """
    Load DISK and LightGlue models
    
    DISK is a learned local feature detector and descriptor that works well
    with LightGlue for feature matching. It provides better results than
    traditional SIFT for many challenging scenes.
    
    Args:
        device: torch device
        max_keypoints: maximum number of keypoints to detect per image
    """
    import io
    import contextlib
    
    try:
        from kornia.feature import DISK, LightGlue
    except ImportError:
        print("Error: kornia not installed. Run: pip install kornia", file=sys.stderr)
        sys.exit(1)
    
    print(f"Loading DISK (max_keypoints={max_keypoints})...", file=sys.stderr)
    disk = DISK.from_pretrained('depth').to(device)
    disk.eval()
    
    print("Loading LightGlue...", file=sys.stderr)
    # Suppress kornia's "Loaded LightGlue model" stdout message
    with contextlib.redirect_stdout(io.StringIO()):
        lightglue = LightGlue(features='disk').to(device)
    lightglue.eval()
    
    return disk, lightglue


def load_image(image_path: Path, max_size: int = 1600) -> tuple[torch.Tensor, tuple[int, int], float, tuple[int, int]]:
    """
    Load and preprocess image for feature extraction
    
    Args:
        image_path: path to image
        max_size: maximum dimension (resize if larger)
        
    Returns:
        tensor: image tensor [1, 3, H, W] RGB normalized, padded to be divisible by 16
        original_size: (width, height) of original image
        scale: scale factor applied
        padded_size: (width, height) after padding (for unpadding keypoints)
    """
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Could not load image: {image_path}")
    
    original_size = (img.shape[1], img.shape[0])  # (width, height)
    
    # Resize if too large
    h, w = img.shape[:2]
    scale = 1.0
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    
    h, w = img.shape[:2]
    
    # Pad to make dimensions divisible by 16 (required by DISK's U-Net)
    pad_h = (16 - h % 16) % 16
    pad_w = (16 - w % 16) % 16
    if pad_h > 0 or pad_w > 0:
        img = cv2.copyMakeBorder(img, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT)
    
    resized_size = (w, h)  # Size before padding (for keypoint filtering)
    
    # Convert BGR to RGB and normalize
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    tensor = torch.from_numpy(img_rgb).float() / 255.0
    tensor = tensor.permute(2, 0, 1).unsqueeze(0)  # [1, 3, H, W]
    
    return tensor, original_size, scale, resized_size


def extract_features(
    disk: torch.nn.Module,
    image_path: Path,
    device: torch.device,
    max_size: int = 1600,
    max_keypoints: int = 2048
) -> dict:
    """
    Extract DISK features from an image
    
    Returns dict with:
        keypoints: [N, 2] xy coordinates (in original image space)
        descriptors: [N, 128] descriptors
        scores: [N] detection scores
        image_size: (width, height) of original image
    """
    tensor, original_size, scale, resized_size = load_image(image_path, max_size)
    tensor = tensor.to(device)
    
    with torch.no_grad():
        features_list = disk(tensor, n=max_keypoints)
    
    features = features_list[0]  # First (only) image
    
    # Get keypoints
    keypoints = features.keypoints.cpu().numpy()  # [N, 2]
    descriptors = features.descriptors.cpu().numpy()  # [N, 128]
    scores = features.detection_scores.cpu().numpy()  # [N]
    
    # Filter out keypoints that fall in the padded region
    w_limit, h_limit = resized_size
    valid_mask = (keypoints[:, 0] < w_limit) & (keypoints[:, 1] < h_limit)
    keypoints = keypoints[valid_mask]
    descriptors = descriptors[valid_mask]
    scores = scores[valid_mask]
    
    # Scale keypoints back to original image size
    if scale != 1.0:
        keypoints = keypoints / scale
    
    return {
        'keypoints': keypoints,
        'descriptors': descriptors,
        'scores': scores,
        'image_size': original_size
    }


def match_features(
    lightglue: torch.nn.Module,
    features0: dict,
    features1: dict,
    device: torch.device
) -> np.ndarray:
    """
    Match features between two images using LightGlue
    
    Returns:
        matches: [M, 2] array of (idx0, idx1) matched keypoint indices
    """
    # Prepare input tensors
    kpts0 = torch.from_numpy(features0['keypoints']).float().unsqueeze(0).to(device)
    kpts1 = torch.from_numpy(features1['keypoints']).float().unsqueeze(0).to(device)
    desc0 = torch.from_numpy(features0['descriptors']).float().unsqueeze(0).to(device)
    desc1 = torch.from_numpy(features1['descriptors']).float().unsqueeze(0).to(device)
    
    # Image sizes for normalization
    size0 = torch.tensor(features0['image_size']).float().unsqueeze(0).to(device)
    size1 = torch.tensor(features1['image_size']).float().unsqueeze(0).to(device)
    
    with torch.no_grad():
        matches = lightglue({
            'image0': {'keypoints': kpts0, 'descriptors': desc0, 'image_size': size0},
            'image1': {'keypoints': kpts1, 'descriptors': desc1, 'image_size': size1}
        })
    
    # Extract match indices
    match_indices = matches['matches'][0].cpu().numpy()  # [M, 2]
    
    return match_indices


def create_colmap_database(db_path: Path):
    """Create a new COLMAP database with required tables"""
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # Create tables (COLMAP schema)
    cursor.executescript('''
        CREATE TABLE IF NOT EXISTS cameras (
            camera_id INTEGER PRIMARY KEY,
            model INTEGER NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            params BLOB NOT NULL,
            prior_focal_length INTEGER NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS images (
            image_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            camera_id INTEGER NOT NULL,
            prior_qw REAL,
            prior_qx REAL,
            prior_qy REAL,
            prior_qz REAL,
            prior_tx REAL,
            prior_ty REAL,
            prior_tz REAL,
            FOREIGN KEY(camera_id) REFERENCES cameras(camera_id)
        );
        
        CREATE TABLE IF NOT EXISTS keypoints (
            image_id INTEGER PRIMARY KEY,
            rows INTEGER NOT NULL,
            cols INTEGER NOT NULL,
            data BLOB NOT NULL,
            FOREIGN KEY(image_id) REFERENCES images(image_id)
        );
        
        CREATE TABLE IF NOT EXISTS descriptors (
            image_id INTEGER PRIMARY KEY,
            rows INTEGER NOT NULL,
            cols INTEGER NOT NULL,
            data BLOB NOT NULL,
            FOREIGN KEY(image_id) REFERENCES images(image_id)
        );
        
        CREATE TABLE IF NOT EXISTS matches (
            pair_id INTEGER PRIMARY KEY,
            rows INTEGER NOT NULL,
            cols INTEGER NOT NULL,
            data BLOB NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS two_view_geometries (
            pair_id INTEGER PRIMARY KEY,
            rows INTEGER NOT NULL,
            cols INTEGER NOT NULL,
            data BLOB NOT NULL,
            config INTEGER NOT NULL,
            F BLOB,
            E BLOB,
            H BLOB,
            qvec BLOB,
            tvec BLOB
        );
    ''')
    
    conn.commit()
    return conn


def image_ids_to_pair_id(image_id1: int, image_id2: int) -> int:
    """Convert two image IDs to COLMAP pair ID"""
    if image_id1 > image_id2:
        image_id1, image_id2 = image_id2, image_id1
    return image_id1 * 2147483647 + image_id2


def add_camera(conn: sqlite3.Connection, camera_id: int, width: int, height: int):
    """Add a simple pinhole camera to the database"""
    cursor = conn.cursor()
    
    # SIMPLE_PINHOLE model (model_id=0): f, cx, cy
    focal = max(width, height) * 1.2  # Initial focal length estimate
    cx, cy = width * 0.5, height * 0.5
    params = np.array([focal, cx, cy], dtype=np.float64)
    
    cursor.execute(
        'INSERT OR REPLACE INTO cameras VALUES (?, ?, ?, ?, ?, ?)',
        (camera_id, 0, width, height, params.tobytes(), 1)
    )
    conn.commit()


def add_image(conn: sqlite3.Connection, image_id: int, name: str, camera_id: int):
    """Add an image to the database"""
    cursor = conn.cursor()
    cursor.execute(
        'INSERT OR REPLACE INTO images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (image_id, name, camera_id, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    )
    conn.commit()


def add_keypoints(conn: sqlite3.Connection, image_id: int, keypoints: np.ndarray):
    """Add keypoints to the database"""
    cursor = conn.cursor()
    
    # COLMAP expects [N, 6]: x, y, scale, orientation, response, octave
    # We only have x, y from DISK, pad the rest
    n_kpts = keypoints.shape[0]
    kpts_full = np.zeros((n_kpts, 6), dtype=np.float32)
    kpts_full[:, :2] = keypoints
    kpts_full[:, 2] = 1.0  # scale
    
    cursor.execute(
        'INSERT OR REPLACE INTO keypoints VALUES (?, ?, ?, ?)',
        (image_id, n_kpts, 6, kpts_full.tobytes())
    )
    conn.commit()


def add_descriptors(conn: sqlite3.Connection, image_id: int, descriptors: np.ndarray):
    """Add descriptors to the database"""
    cursor = conn.cursor()
    
    # Convert to uint8 (COLMAP uses L2-normalized uint8 descriptors)
    # DISK outputs float descriptors, normalize and convert
    desc_normalized = descriptors / (np.linalg.norm(descriptors, axis=1, keepdims=True) + 1e-8)
    desc_uint8 = ((desc_normalized + 1) * 127.5).clip(0, 255).astype(np.uint8)
    
    cursor.execute(
        'INSERT OR REPLACE INTO descriptors VALUES (?, ?, ?, ?)',
        (image_id, descriptors.shape[0], descriptors.shape[1], desc_uint8.tobytes())
    )
    conn.commit()


def add_matches(conn: sqlite3.Connection, image_id1: int, image_id2: int, matches: np.ndarray):
    """Add matches between two images to the database"""
    cursor = conn.cursor()
    pair_id = image_ids_to_pair_id(image_id1, image_id2)
    
    # Ensure correct order
    if image_id1 > image_id2:
        matches = matches[:, ::-1]
    
    matches_uint32 = matches.astype(np.uint32)
    
    cursor.execute(
        'INSERT OR REPLACE INTO matches VALUES (?, ?, ?, ?)',
        (pair_id, matches.shape[0], 2, matches_uint32.tobytes())
    )
    conn.commit()


def verify_matches_and_add_geometry(
    conn: sqlite3.Connection,
    image_id1: int,
    image_id2: int,
    kpts1: np.ndarray,
    kpts2: np.ndarray,
    matches: np.ndarray,
    min_inliers: int = 15
) -> int:
    """
    Geometrically verify matches using RANSAC and add to two_view_geometries.
    Returns number of inliers.
    """
    if len(matches) < min_inliers:
        return 0
    
    # Get matched keypoint coordinates
    pts1 = kpts1[matches[:, 0]]
    pts2 = kpts2[matches[:, 1]]
    
    # Use OpenCV to find fundamental matrix with RANSAC
    try:
        F, mask = cv2.findFundamentalMat(pts1, pts2, cv2.FM_RANSAC, 3.0, 0.99)
        if F is None or mask is None:
            return 0
        
        inlier_mask = mask.ravel() == 1
        inlier_indices = np.where(inlier_mask)[0]
        n_inliers = len(inlier_indices)
        
        if n_inliers < min_inliers:
            return 0
        
        # Get inlier matches
        inlier_matches = matches[inlier_indices]
        
        # Ensure correct order for database
        pair_id = image_ids_to_pair_id(image_id1, image_id2)
        if image_id1 > image_id2:
            inlier_matches = inlier_matches[:, ::-1]
        
        inlier_matches_uint32 = inlier_matches.astype(np.uint32)
        
        # Store in two_view_geometries
        # config: 2 = CALIBRATED (fundamental matrix verified)
        cursor = conn.cursor()
        cursor.execute(
            'INSERT OR REPLACE INTO two_view_geometries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (pair_id, n_inliers, 2, inlier_matches_uint32.tobytes(), 
             2,  # config = CALIBRATED
             F.tobytes() if F is not None else None,  # F matrix
             None,  # E matrix
             None,  # H matrix  
             None,  # qvec
             None)  # tvec
        )
        conn.commit()
        
        return n_inliers
        
    except Exception as e:
        print(f"Geometric verification failed: {e}", file=sys.stderr)
        return 0


def process_images(
    image_dir: Path,
    output_db: Path,
    max_keypoints: int = 2048,
    max_image_size: int = 1600,
    match_all: bool = True,
    force_cpu: bool = False
) -> dict:
    """
    Process all images: extract features and compute matches
    
    Args:
        image_dir: directory containing images
        output_db: path to output COLMAP database
        max_keypoints: maximum keypoints per image
        max_image_size: resize images larger than this
        match_all: if True, match all pairs (exhaustive)
        force_cpu: if True, force CPU even if CUDA is available
        
    Returns:
        summary dict with statistics
    """
    # Find images
    image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
    images = sorted([
        f for f in image_dir.iterdir()
        if f.is_file() and f.suffix.lower() in image_extensions
    ])
    
    if not images:
        raise ValueError(f"No images found in {image_dir}")
    
    print(f"Found {len(images)} images", file=sys.stderr)
    
    # Setup - try CUDA first, fallback to CPU if needed
    device = get_device(force_cpu)
    disk, lightglue = setup_models(device, max_keypoints)
    
    # Test CUDA with a small tensor to catch kernel issues early
    if device.type == 'cuda' and not force_cpu:
        try:
            # Use 48x48 (divisible by 16) for the test
            test_tensor = torch.zeros(1, 3, 48, 48, device=device)
            with torch.no_grad():
                _ = disk.unet(test_tensor)
            del test_tensor
            torch.cuda.empty_cache()
            print("CUDA test passed", file=sys.stderr)
        except RuntimeError as e:
            error_msg = str(e).lower()
            if "no kernel image" in error_msg or "cuda" in error_msg:
                print(f"CUDA kernel error detected, falling back to CPU...", file=sys.stderr)
                # Move models to CPU
                device = torch.device("cpu")
                disk = disk.to(device)
                lightglue = lightglue.to(device)
                print("Switched to CPU mode", file=sys.stderr)
            else:
                raise
    
    # Create database
    if output_db.exists():
        output_db.unlink()
    conn = create_colmap_database(output_db)
    
    # Extract features for all images
    print("Extracting features...", file=sys.stderr)
    all_features = {}
    
    for i, image_path in enumerate(tqdm(images, desc="Features", file=sys.stderr)):
        image_id = i + 1
        
        features = extract_features(disk, image_path, device, max_image_size, max_keypoints)
        all_features[image_id] = features
        
        # Add to database
        width, height = features['image_size']
        add_camera(conn, image_id, width, height)
        add_image(conn, image_id, image_path.name, image_id)
        add_keypoints(conn, image_id, features['keypoints'])
        add_descriptors(conn, image_id, features['descriptors'])
    
    # Match features between image pairs
    print("Matching features...", file=sys.stderr)
    n_images = len(images)
    total_matches = 0
    total_inliers = 0
    pair_count = 0
    verified_pairs = 0
    
    if match_all:
        # Exhaustive matching
        pairs = [(i, j) for i in range(1, n_images + 1) for j in range(i + 1, n_images + 1)]
    else:
        # Sequential matching (for video sequences)
        pairs = [(i, i + 1) for i in range(1, n_images)]
    
    for id1, id2 in tqdm(pairs, desc="Matching", file=sys.stderr):
        matches = match_features(lightglue, all_features[id1], all_features[id2], device)
        
        if len(matches) > 0:
            add_matches(conn, id1, id2, matches)
            total_matches += len(matches)
            pair_count += 1
            
            # Geometric verification with RANSAC
            n_inliers = verify_matches_and_add_geometry(
                conn, id1, id2,
                all_features[id1]['keypoints'],
                all_features[id2]['keypoints'],
                matches
            )
            if n_inliers > 0:
                total_inliers += n_inliers
                verified_pairs += 1
    
    print(f"Verified {verified_pairs}/{pair_count} pairs with {total_inliers} total inliers", file=sys.stderr)
    
    conn.close()
    
    # Summary
    avg_keypoints = np.mean([f['keypoints'].shape[0] for f in all_features.values()])
    avg_matches = total_matches / max(pair_count, 1)
    avg_inliers = total_inliers / max(verified_pairs, 1)
    
    summary = {
        "images": len(images),
        "verified_pairs": verified_pairs,
        "total_inliers": total_inliers,
        "avg_inliers_per_pair": float(avg_inliers),
        "pairs_matched": pair_count,
        "total_matches": total_matches,
        "avg_keypoints_per_image": float(avg_keypoints),
        "avg_matches_per_pair": float(avg_matches),
        "database": str(output_db)
    }
    
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="DISK + LightGlue feature extraction for COLMAP"
    )
    parser.add_argument(
        "--input_dir", type=str, required=True,
        help="Directory containing images"
    )
    parser.add_argument(
        "--output_db", type=str, required=True,
        help="Output COLMAP database path"
    )
    parser.add_argument(
        "--max_keypoints", type=int, default=2048,
        help="Maximum keypoints per image (default: 2048)"
    )
    parser.add_argument(
        "--max_image_size", type=int, default=1600,
        help="Resize images larger than this (default: 1600)"
    )
    parser.add_argument(
        "--sequential", action="store_true",
        help="Use sequential matching instead of exhaustive"
    )
    parser.add_argument(
        "--cpu", action="store_true",
        help="Force CPU mode (slower but more compatible)"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output summary as JSON to stdout"
    )
    
    args = parser.parse_args()
    
    input_dir = Path(args.input_dir)
    output_db = Path(args.output_db)
    
    if not input_dir.exists():
        print(f"Error: Input directory does not exist: {input_dir}", file=sys.stderr)
        sys.exit(1)
    
    try:
        summary = process_images(
            image_dir=input_dir,
            output_db=output_db,
            max_keypoints=args.max_keypoints,
            max_image_size=args.max_image_size,
            match_all=not args.sequential,
            force_cpu=args.cpu
        )
        
        if args.json:
            print(json.dumps(summary))
        else:
            print(f"\nProcessed {summary['images']} images", file=sys.stderr)
            print(f"Matched {summary['pairs_matched']} pairs with {summary['total_matches']} total matches", file=sys.stderr)
            print(f"Avg keypoints: {summary['avg_keypoints_per_image']:.0f}, Avg matches: {summary['avg_matches_per_pair']:.0f}", file=sys.stderr)
            print(f"Database: {summary['database']}", file=sys.stderr)
            
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
