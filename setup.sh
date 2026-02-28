#!/usr/bin/env bash
# =============================================================================
# Beatrix Night Vision Camera - One-Click Setup
# =============================================================================
# Hardware: Raspberry Pi Zero 2W + Camera Module 3 (IMX708) + 940nm IR LED
# OS:       Raspberry Pi OS Lite 64-bit (Bookworm)
# Stream:   mediamtx with direct rpicam integration
#
# Usage:    sudo bash setup.sh
# Idempotent - safe to run multiple times.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MEDIAMTX_VERSION="v1.11.3"
INSTALL_DIR="/opt/mediamtx"
CONFIG_SRC="$(cd "$(dirname "$0")" && pwd)/config"
WEB_SRC="$(cd "$(dirname "$0")" && pwd)/web"
WEB_DEST="/var/www/beatrix-cam"
HOSTNAME_TARGET="beatrix-cam"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root (use sudo)." >&2
    exit 1
fi

ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" ]]; then
    echo "WARNING: Expected aarch64 (ARM64), detected '$ARCH'."
    echo "         This setup targets Raspberry Pi Zero 2W (64-bit OS)."
    read -rp "Continue anyway? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

echo "========================================="
echo " Beatrix Cam Setup"
echo "========================================="
echo ""

# ---------------------------------------------------------------------------
# 1. System update and dependencies
# ---------------------------------------------------------------------------
echo "[1/8] Updating system packages..."
apt-get update
apt-get upgrade -y

echo "[2/8] Installing dependencies..."
apt-get install -y \
    nginx-light \
    curl \
    tar \
    libcamera-apps \
    python3-libcamera \
    python3-picamera2

# ---------------------------------------------------------------------------
# 2. Camera configuration
# ---------------------------------------------------------------------------
echo "[3/8] Configuring camera..."

# Ensure the camera dtoverlay is enabled in /boot/firmware/config.txt
BOOT_CONFIG="/boot/firmware/config.txt"
if [[ ! -f "$BOOT_CONFIG" ]]; then
    # Older Raspberry Pi OS uses /boot/config.txt
    BOOT_CONFIG="/boot/config.txt"
fi

if ! grep -q "^dtoverlay=imx708" "$BOOT_CONFIG" 2>/dev/null; then
    # Add camera overlay if not already present
    echo "" >> "$BOOT_CONFIG"
    echo "# Beatrix Cam - Camera Module 3 (IMX708)" >> "$BOOT_CONFIG"
    echo "dtoverlay=imx708" >> "$BOOT_CONFIG"
    echo "  -> Added imx708 dtoverlay to $BOOT_CONFIG"
else
    echo "  -> imx708 dtoverlay already configured"
fi

# Ensure the legacy camera interface is NOT enabled (we use libcamera)
if grep -q "^start_x=1" "$BOOT_CONFIG" 2>/dev/null; then
    sed -i 's/^start_x=1/#start_x=1  # Disabled for libcamera/' "$BOOT_CONFIG"
    echo "  -> Disabled legacy camera interface"
fi

# Increase GPU memory for camera + hardware encoding
if ! grep -q "^gpu_mem=" "$BOOT_CONFIG" 2>/dev/null; then
    echo "gpu_mem=128" >> "$BOOT_CONFIG"
    echo "  -> Set GPU memory to 128MB"
elif grep -q "^gpu_mem=" "$BOOT_CONFIG"; then
    current_gpu=$(grep "^gpu_mem=" "$BOOT_CONFIG" | head -1 | cut -d= -f2)
    if [[ "$current_gpu" -lt 128 ]]; then
        sed -i "s/^gpu_mem=.*/gpu_mem=128/" "$BOOT_CONFIG"
        echo "  -> Increased GPU memory to 128MB (was ${current_gpu}MB)"
    else
        echo "  -> GPU memory already sufficient (${current_gpu}MB)"
    fi
fi

# ---------------------------------------------------------------------------
# 3. Install mediamtx
# ---------------------------------------------------------------------------
echo "[4/8] Installing mediamtx..."

mkdir -p "$INSTALL_DIR"

# Check if mediamtx binary already exists (e.g. manually placed)
if [[ -f "$INSTALL_DIR/mediamtx" ]]; then
    echo "  -> mediamtx binary already exists at $INSTALL_DIR/mediamtx, skipping download"
else
    MEDIAMTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_arm64v8.tar.gz"
    TEMP_TAR=$(mktemp /tmp/mediamtx.XXXXXX.tar.gz)

    echo "  -> Downloading mediamtx ${MEDIAMTX_VERSION} for ARM64..."
    curl -fsSL "$MEDIAMTX_URL" -o "$TEMP_TAR"
    tar -xzf "$TEMP_TAR" -C "$INSTALL_DIR" mediamtx
    rm -f "$TEMP_TAR"
    chmod +x "$INSTALL_DIR/mediamtx"
    echo "  -> Installed to $INSTALL_DIR/mediamtx"
fi

# ---------------------------------------------------------------------------
# 4. Deploy configuration files
# ---------------------------------------------------------------------------
echo "[5/8] Deploying configuration files..."

# mediamtx config
cp "$CONFIG_SRC/mediamtx.yml" "$INSTALL_DIR/mediamtx.yml"

# Check if the NoIR tuning file exists; if not, comment out the line
# to let mediamtx/libcamera use the default tuning for the detected sensor
NOIR_TUNING="/usr/share/libcamera/ipa/rpi/vc4/imx708_noir.json"
if [[ ! -f "$NOIR_TUNING" ]]; then
    sed -i 's|^\(\s*rpiCameraTuningFile:.*\)|# \1  # NoIR tuning file not found, using default|' "$INSTALL_DIR/mediamtx.yml"
    echo "  -> NoIR tuning file not found — using default camera tuning"
    echo "     (For best IR performance, use Camera Module 3 NoIR)"
fi
echo "  -> Copied mediamtx.yml"

# systemd service for mediamtx
cp "$CONFIG_SRC/beatrix-cam.service" /etc/systemd/system/beatrix-cam.service
echo "  -> Installed beatrix-cam.service"

# systemd service for nginx (custom wrapper that depends on mediamtx)
cp "$CONFIG_SRC/beatrix-web.service" /etc/systemd/system/beatrix-web.service
echo "  -> Installed beatrix-web.service"

# nginx config
cp "$CONFIG_SRC/nginx.conf" /etc/nginx/sites-available/beatrix-cam
ln -sf /etc/nginx/sites-available/beatrix-cam /etc/nginx/sites-enabled/beatrix-cam
rm -f /etc/nginx/sites-enabled/default
echo "  -> Installed nginx config"

# ---------------------------------------------------------------------------
# 5. Deploy web frontend
# ---------------------------------------------------------------------------
echo "[6/8] Deploying web frontend..."

mkdir -p "$WEB_DEST"
if [[ -d "$WEB_SRC" ]]; then
    cp -r "$WEB_SRC/"* "$WEB_DEST/" 2>/dev/null || true
    chown -R www-data:www-data "$WEB_DEST"
    echo "  -> Web files deployed to $WEB_DEST"
else
    echo "  -> WARNING: No web/ directory found, skipping frontend deployment"
fi

# ---------------------------------------------------------------------------
# 6. Set hostname
# ---------------------------------------------------------------------------
echo "[7/8] Setting hostname..."

CURRENT_HOSTNAME=$(hostname)
if [[ "$CURRENT_HOSTNAME" != "$HOSTNAME_TARGET" ]]; then
    hostnamectl set-hostname "$HOSTNAME_TARGET" 2>/dev/null || \
        echo "$HOSTNAME_TARGET" > /etc/hostname
    # Update /etc/hosts
    sed -i "s/127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_TARGET/" /etc/hosts
    echo "  -> Hostname set to $HOSTNAME_TARGET (was $CURRENT_HOSTNAME)"
else
    echo "  -> Hostname already set to $HOSTNAME_TARGET"
fi

# ---------------------------------------------------------------------------
# 7. Enable and start services
# ---------------------------------------------------------------------------
echo "[8/8] Enabling and starting services..."

systemctl daemon-reload

# Disable stock nginx service in favor of our custom wrapper
systemctl disable nginx.service 2>/dev/null || true
systemctl stop nginx.service 2>/dev/null || true

# Enable services to start on boot
systemctl enable beatrix-cam.service
systemctl enable beatrix-web.service

# Restart services (handles both first run and updates)
systemctl restart beatrix-cam.service
systemctl restart beatrix-web.service

echo ""
echo "========================================="
echo " Setup Complete!"
echo "========================================="
echo ""
echo " Stream endpoints:"
echo "   Web UI:  http://${HOSTNAME_TARGET}.local/"
echo "   WebRTC:  http://${HOSTNAME_TARGET}.local:8889/beatrix"
echo "   HLS:     http://${HOSTNAME_TARGET}.local:8888/beatrix"
echo "   RTSP:    rtsp://${HOSTNAME_TARGET}.local:8554/beatrix"
echo "   API:     http://${HOSTNAME_TARGET}.local:9997"
echo ""
echo " Useful commands:"
echo "   sudo systemctl status beatrix-cam"
echo "   sudo journalctl -u beatrix-cam -f"
echo "   sudo systemctl restart beatrix-cam"
echo ""
echo " NOTE: If this is the first run, a reboot may be required"
echo "       for camera dtoverlay changes to take effect."
echo "========================================="
