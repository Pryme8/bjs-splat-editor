# Splat Editor Backend Dockerfile
# Includes COLMAP for Structure from Motion

FROM ubuntu:22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    cmake \
    ninja-build \
    libboost-program-options-dev \
    libboost-filesystem-dev \
    libboost-graph-dev \
    libboost-system-dev \
    libeigen3-dev \
    libflann-dev \
    libfreeimage-dev \
    libmetis-dev \
    libgoogle-glog-dev \
    libgflags-dev \
    libsqlite3-dev \
    libglew-dev \
    qtbase5-dev \
    libqt5opengl5-dev \
    libcgal-dev \
    libceres-dev \
    && rm -rf /var/lib/apt/lists/*

# Install COLMAP from source (for latest version)
WORKDIR /tmp
RUN git clone https://github.com/colmap/colmap.git && \
    cd colmap && \
    git checkout 3.8 && \
    mkdir build && \
    cd build && \
    cmake .. -GNinja -DCMAKE_BUILD_TYPE=Release -DCUDA_ENABLED=OFF && \
    ninja && \
    ninja install && \
    cd / && \
    rm -rf /tmp/colmap

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Create data directories
RUN mkdir -p /app/data/uploads /app/data/results

# Set environment variables
ENV NODE_ENV=production
ENV PORT=4270
ENV COLMAP_PATH=/usr/local/bin/colmap

# Expose port
EXPOSE 4270

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:4270/api/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
