# QuantumSplat Editor

A modern web-based 3D Gaussian Splatting editor built with Vue 3, Babylon.js, and Vuetify.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

### Viewing & Navigation
- **Dual Camera System**: Switch between Orbit camera (rotate around target) and Fly camera (6DOF drone mode)
- **High-Performance Rendering**: Optimized Babylon.js rendering for large splat files
- **Visual Helpers**: Configurable axes viewer and ground plane grid

### Editing Tools
- **Transform Gizmos**: Translate, rotate, and scale splats with intuitive gizmos
- **World/Local Space**: Toggle between world and local coordinate systems
- **Quick Rotate**: One-click 90° rotations around any axis
- **Undo/Redo**: Full history support with Ctrl+Z / Ctrl+Y

### Clipping Tools
- **Clipping Sphere**: Spherical region cropping with adjustable radius
- **Clipping Box**: Axis-aligned box cropping with independent X/Y/Z sizing
- **Draggable Gizmos**: Position clipping regions precisely with gizmos

### File Support
- **Import**: PLY, SPLAT, SPZ formats
- **Export**: PLY and SPLAT formats
- **Drag & Drop**: Quick file loading

### Generator (Optional Backend)
- **AI-Powered Generation**: Create splats from images using OpenSplat
- **COLMAP Integration**: Automatic camera calibration
- **Real-time Preview**: Watch training progress with live splat preview

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/prymeio/bjs-splat-editor.git
cd bjs-splat-editor

# Install frontend dependencies
npm install

# Start development server
npm run dev
```

### Backend (Optional)
The backend enables AI splat generation from images.

```bash
cd backend
cp .env.example .env
# Edit .env with your settings
npm install
npm run dev
```

## Controls

### Orbit Camera (Default)
- **Left Mouse**: Rotate around target
- **Right Mouse**: Pan
- **Scroll**: Zoom in/out

### Fly Camera (Drone Mode)
- **W/S**: Move forward/backward
- **A/D**: Strafe left/right
- **R/F**: Move up/down
- **Q/E**: Roll left/right
- **Mouse Drag**: Look around

### Keyboard Shortcuts
- **Ctrl+Z**: Undo
- **Ctrl+Y**: Redo

## Tech Stack

- **Frontend**: Vue 3, TypeScript, Vuetify 3
- **3D Engine**: Babylon.js with Gaussian Splatting support
- **Build Tool**: Vite
- **Backend**: Express, Bull (job queue), WebSocket

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
