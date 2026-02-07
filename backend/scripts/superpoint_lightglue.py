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
) -> tuple[dict, dict]:
    """
    Extract DISK features from an image
    
    Returns tuple of:
        numpy_features: dict with numpy arrays for DB storage
            keypoints: [N, 2] xy coordinates (in original image space)
            descriptors: [N, 128] descriptors
            scores: [N] detection scores
            image_size: (width, height) of original image
        gpu_features: dict with pre-transferred GPU tensors for matching
            keypoints: [1, N, 2] tensor on device
            descriptors: [1, N, 128] tensor on device
            image_size: [1, 2] tensor on device
    """
    tensor, original_size, scale, resized_size = load_image(image_path, max_size)
    tensor = tensor.to(device)
    
    with torch.no_grad():
        features_list = disk(tensor, n=max_keypoints)
    
    features = features_list[0]  # First (only) image
    
    # Get raw tensors on device
    kpts_tensor = features.keypoints      # [N, 2] on device
    desc_tensor = features.descriptors    # [N, 128] on device
    scores_tensor = features.detection_scores  # [N] on device
    
    # Filter out keypoints that fall in the padded region (on GPU)
    w_limit, h_limit = resized_size
    valid_mask = (kpts_tensor[:, 0] < w_limit) & (kpts_tensor[:, 1] < h_limit)
    kpts_tensor = kpts_tensor[valid_mask]
    desc_tensor = desc_tensor[valid_mask]
    scores_tensor = scores_tensor[valid_mask]
    
    # Scale keypoints back to original image size
    if scale != 1.0:
        kpts_tensor = kpts_tensor / scale
    
    # CPU/numpy copies for database storage
    keypoints_np = kpts_tensor.cpu().numpy()
    descriptors_np = desc_tensor.cpu().numpy()
    scores_np = scores_tensor.cpu().numpy()
    
    numpy_features = {
        'keypoints': keypoints_np,
        'descriptors': descriptors_np,
        'scores': scores_np,
        'image_size': original_size
    }
    
    # Pre-transferred GPU tensors for matching (batched dim added)
    size_tensor = torch.tensor(original_size, dtype=torch.float32, device=device).unsqueeze(0)
    gpu_features = {
        'keypoints': kpts_tensor.float().unsqueeze(0),
        'descriptors': desc_tensor.float().unsqueeze(0),
        'image_size': size_tensor
    }
    
    return numpy_features, gpu_features


def match_features(
    lightglue: torch.nn.Module,
    gpu_feat0: dict,
    gpu_feat1: dict,
) -> np.ndarray:
    """
    Match features between two images using LightGlue.
    Accepts pre-transferred GPU tensors to avoid per-pair CPU-GPU transfers.
    
    Args:
        lightglue: LightGlue model
        gpu_feat0: dict with 'keypoints', 'descriptors', 'image_size' tensors on device
        gpu_feat1: dict with 'keypoints', 'descriptors', 'image_size' tensors on device
        
    Returns:
        matches: [M, 2] numpy array of (idx0, idx1) matched keypoint indices
    """
    with torch.no_grad():
        matches = lightglue({
            'image0': gpu_feat0,
            'image1': gpu_feat1
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


def add_camera(cursor: sqlite3.Cursor, camera_id: int, width: int, height: int):
    """Add a simple pinhole camera to the database (caller manages transaction)"""
    # SIMPLE_PINHOLE model (model_id=0): f, cx, cy
    focal = max(width, height) * 1.2  # Initial focal length estimate
    cx, cy = width * 0.5, height * 0.5
    params = np.array([focal, cx, cy], dtype=np.float64)
    
    cursor.execute(
        'INSERT OR REPLACE INTO cameras VALUES (?, ?, ?, ?, ?, ?)',
        (camera_id, 0, width, height, params.tobytes(), 1)
    )


def add_image(cursor: sqlite3.Cursor, image_id: int, name: str, camera_id: int):
    """Add an image to the database (caller manages transaction)"""
    cursor.execute(
        'INSERT OR REPLACE INTO images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (image_id, name, camera_id, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    )


def add_keypoints(cursor: sqlite3.Cursor, image_id: int, keypoints: np.ndarray):
    """Add keypoints to the database (caller manages transaction)"""
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


def add_descriptors(cursor: sqlite3.Cursor, image_id: int, descriptors: np.ndarray):
    """Add descriptors to the database (caller manages transaction)"""
    # Convert to uint8 (COLMAP uses L2-normalized uint8 descriptors)
    # DISK outputs float descriptors, normalize and convert
    desc_normalized = descriptors / (np.linalg.norm(descriptors, axis=1, keepdims=True) + 1e-8)
    desc_uint8 = ((desc_normalized + 1) * 127.5).clip(0, 255).astype(np.uint8)
    
    cursor.execute(
        'INSERT OR REPLACE INTO descriptors VALUES (?, ?, ?, ?)',
        (image_id, descriptors.shape[0], descriptors.shape[1], desc_uint8.tobytes())
    )


def add_matches(cursor: sqlite3.Cursor, image_id1: int, image_id2: int, matches: np.ndarray):
    """Add matches between two images to the database (caller manages transaction)"""
    pair_id = image_ids_to_pair_id(image_id1, image_id2)
    
    # Ensure correct order
    if image_id1 > image_id2:
        matches = matches[:, ::-1]
    
    matches_uint32 = matches.astype(np.uint32)
    
    cursor.execute(
        'INSERT OR REPLACE INTO matches VALUES (?, ?, ?, ?)',
        (pair_id, matches.shape[0], 2, matches_uint32.tobytes())
    )


def verify_matches_and_add_geometry(
    cursor: sqlite3.Cursor,
    image_id1: int,
    image_id2: int,
    kpts1: np.ndarray,
    kpts2: np.ndarray,
    matches: np.ndarray,
    min_inliers: int = 15
) -> int:
    """
    Geometrically verify matches using RANSAC and add to two_view_geometries.
    Returns number of inliers. Caller manages transaction.
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
        
        return n_inliers
        
    except Exception as e:
        print(f"Geometric verification failed: {e}", file=sys.stderr)
        return 0


def generate_pairs_exhaustive(n_images: int) -> list[tuple[int, int]]:
    """Generate all possible image pairs (O(n^2))"""
    return [(i, j) for i in range(1, n_images + 1) for j in range(i + 1, n_images + 1)]


def generate_pairs_window(n_images: int, window: int = 10) -> list[tuple[int, int]]:
    """Generate pairs within a sliding window (O(n*k) for sequential/video images)"""
    pairs = []
    for i in range(1, n_images + 1):
        for j in range(i + 1, min(i + window + 1, n_images + 1)):
            pairs.append((i, j))
    return pairs


def generate_pairs_retrieval(all_np_features: dict, topk: int = 15) -> list[tuple[int, int]]:
    """
    Generate pairs by retrieving top-k most similar images per image
    using mean-pooled DISK descriptors as cheap global descriptors.
    Good for unordered photo sets.
    """
    n_images = len(all_np_features)
    image_ids = sorted(all_np_features.keys())
    
    # Compute global descriptors (mean of DISK descriptors per image)
    global_descs = []
    for img_id in image_ids:
        desc = all_np_features[img_id]['descriptors']
        global_desc = desc.mean(axis=0)
        # L2 normalize
        norm = np.linalg.norm(global_desc)
        if norm > 0:
            global_desc = global_desc / norm
        global_descs.append(global_desc)
    
    global_descs = np.array(global_descs)  # [N, 128]
    
    # Cosine similarity matrix (global descs are already normalized)
    similarity = global_descs @ global_descs.T  # [N, N]
    
    # For each image, find top-k most similar (excluding self)
    pair_set = set()
    k = min(topk, n_images - 1)
    for i in range(n_images):
        sims = similarity[i].copy()
        sims[i] = -1  # Exclude self
        top_indices = np.argsort(sims)[-k:]
        for j in top_indices:
            id_a = image_ids[i]
            id_b = image_ids[j]
            if id_a < id_b:
                pair_set.add((id_a, id_b))
            else:
                pair_set.add((id_b, id_a))
    
    return sorted(pair_set)


def process_images(
    image_dir: Path,
    output_db: Path,
    max_keypoints: int = 2048,
    max_image_size: int = 1600,
    match_strategy: str = 'window',
    match_window: int = 10,
    match_topk: int = 15,
    skip_verification: bool = True,
    force_cpu: bool = False
) -> dict:
    """
    Process all images: extract features and compute matches
    
    Args:
        image_dir: directory containing images
        output_db: path to output COLMAP database
        max_keypoints: maximum keypoints per image
        max_image_size: resize images larger than this
        match_strategy: 'exhaustive', 'window', or 'retrieval'
        match_window: window size for window matching strategy
        match_topk: top-k for retrieval matching strategy
        skip_verification: skip per-pair RANSAC (COLMAP mapper does its own)
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
    cursor = conn.cursor()
    
    # Extract features for all images
    print("Extracting features...", file=sys.stderr)
    all_np_features = {}   # numpy arrays for DB and verification
    all_gpu_features = {}  # GPU tensors for matching (avoid per-pair transfers)
    
    # Single transaction for all feature inserts
    conn.execute('BEGIN')
    for i, image_path in enumerate(tqdm(images, desc="Features", file=sys.stderr)):
        image_id = i + 1
        
        np_feat, gpu_feat = extract_features(disk, image_path, device, max_image_size, max_keypoints)
        all_np_features[image_id] = np_feat
        all_gpu_features[image_id] = gpu_feat
        
        # Add to database (no per-row commits)
        width, height = np_feat['image_size']
        add_camera(cursor, image_id, width, height)
        add_image(cursor, image_id, image_path.name, image_id)
        add_keypoints(cursor, image_id, np_feat['keypoints'])
        add_descriptors(cursor, image_id, np_feat['descriptors'])
    conn.commit()
    
    # Generate pairs based on strategy
    n_images = len(images)
    print(f"Generating pairs (strategy={match_strategy})...", file=sys.stderr)
    
    if match_strategy == 'exhaustive':
        pairs = generate_pairs_exhaustive(n_images)
    elif match_strategy == 'retrieval':
        pairs = generate_pairs_retrieval(all_np_features, match_topk)
    else:  # 'window' (default)
        pairs = generate_pairs_window(n_images, match_window)
    
    print(f"Matching {len(pairs)} pairs...", file=sys.stderr)
    
    # Match features between image pairs
    total_matches = 0
    total_inliers = 0
    pair_count = 0
    verified_pairs = 0
    
    # Single transaction for all match inserts
    conn.execute('BEGIN')
    for id1, id2 in tqdm(pairs, desc="Matching", file=sys.stderr):
        matches = match_features(lightglue, all_gpu_features[id1], all_gpu_features[id2])
        
        if len(matches) > 0:
            add_matches(cursor, id1, id2, matches)
            total_matches += len(matches)
            pair_count += 1
            
            # Optional geometric verification with RANSAC
            if not skip_verification:
                n_inliers = verify_matches_and_add_geometry(
                    cursor, id1, id2,
                    all_np_features[id1]['keypoints'],
                    all_np_features[id2]['keypoints'],
                    matches
                )
                if n_inliers > 0:
                    total_inliers += n_inliers
                    verified_pairs += 1
    conn.commit()
    
    if skip_verification:
        print(f"Matched {pair_count} pairs (verification skipped, COLMAP mapper will verify)", file=sys.stderr)
    else:
        print(f"Verified {verified_pairs}/{pair_count} pairs with {total_inliers} total inliers", file=sys.stderr)
    
    # Free GPU memory from cached tensors
    del all_gpu_features
    if device.type == 'cuda':
        torch.cuda.empty_cache()
    
    conn.close()
    
    # Summary
    avg_keypoints = np.mean([f['keypoints'].shape[0] for f in all_np_features.values()])
    avg_matches = total_matches / max(pair_count, 1)
    avg_inliers = total_inliers / max(verified_pairs, 1) if not skip_verification else 0
    
    summary = {
        "images": len(images),
        "match_strategy": match_strategy,
        "total_pairs": len(pairs),
        "verified_pairs": verified_pairs,
        "total_inliers": total_inliers,
        "avg_inliers_per_pair": float(avg_inliers),
        "pairs_matched": pair_count,
        "total_matches": total_matches,
        "avg_keypoints_per_image": float(avg_keypoints),
        "avg_matches_per_pair": float(avg_matches),
        "database": str(output_db),
        "device_type": "gpu" if device.type in ['cuda', 'mps'] else "cpu",
        "device_name": torch.cuda.get_device_name(0) if device.type == 'cuda' else device.type.upper()
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
    # Legacy flag - maps to --match_strategy window with window=1
    parser.add_argument(
        "--sequential", action="store_true",
        help="(Legacy) Use sequential matching. Prefer --match_strategy instead."
    )
    parser.add_argument(
        "--match_strategy", type=str, default="window",
        choices=["exhaustive", "window", "retrieval"],
        help="Pair selection strategy: exhaustive (all pairs), window (sliding window for sequential images), retrieval (top-k by descriptor similarity). Default: window"
    )
    parser.add_argument(
        "--match_window", type=int, default=10,
        help="Window size for 'window' match strategy (default: 10)"
    )
    parser.add_argument(
        "--match_topk", type=int, default=15,
        help="Top-k similar images per image for 'retrieval' match strategy (default: 15)"
    )
    parser.add_argument(
        "--skip_verification", action="store_true", default=False,
        help="Skip per-pair RANSAC geometric verification (only if your COLMAP mapper handles it). Default: off"
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Force per-pair RANSAC geometric verification (overrides --skip_verification)"
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
    
    # Handle legacy --sequential flag
    match_strategy = args.match_strategy
    if args.sequential:
        match_strategy = 'window'
    
    # --verify overrides --skip_verification
    skip_verification = args.skip_verification and not args.verify
    
    try:
        summary = process_images(
            image_dir=input_dir,
            output_db=output_db,
            max_keypoints=args.max_keypoints,
            max_image_size=args.max_image_size,
            match_strategy=match_strategy,
            match_window=args.match_window,
            match_topk=args.match_topk,
            skip_verification=skip_verification,
            force_cpu=args.cpu
        )
        
        if args.json:
            print(json.dumps(summary))
        else:
            print(f"\nProcessed {summary['images']} images", file=sys.stderr)
            print(f"Strategy: {summary['match_strategy']}, {summary['total_pairs']} pairs generated", file=sys.stderr)
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
