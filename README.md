# BEATRIX CAM

### Night Vision Live Stream for 小脆

A production-grade night vision live streaming system built on Raspberry Pi Zero 2W.
Watch Beatrix 24/7 from any device — phone, tablet, or desktop.

```
  ┌─────────────────────────────────────────┐
  │  ◉ BEATRIX          LIVE   ● 720p 30fps │
  │                                         │
  │           ┌───────────────┐             │
  │           │   🐍 940nm    │             │
  │           │   Night Vision │             │
  │           │    Stream     │             │
  │           └───────────────┘             │
  │                                         │
  │  00:32:15              Feb 28, 2026     │
  └─────────────────────────────────────────┘
```

---

## Hardware

| Component | Model | Notes |
|-----------|-------|-------|
| Board | Raspberry Pi Zero 2W | ARM64, 512MB RAM |
| Camera | Camera Module 3 **NoIR** | IMX708 sensor, no IR filter |
| IR Light | 940nm 1W IR LED | Independent power, invisible to snakes |
| Power | 5V 2.5A USB-C | For the Pi |
| MicroSD | 16GB+ Class 10 | A1-rated recommended |

> **Important:** The standard Camera Module 3 has an IR-cut filter that blocks 940nm light.
> You need the **NoIR** variant (Camera Module 3 NoIR) for proper infrared night vision.
> If you have the standard version, the image will appear very dark under IR-only illumination.

> **About the IR LED:** The 940nm wavelength is completely invisible to snakes (and humans).
> The LED operates independently — just connect it to power. No GPIO control needed.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Raspberry Pi Zero 2W            │
│                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Camera   │───▶│ mediamtx │───▶│  nginx   │  │
│  │ Module 3 │    │          │    │  :80     │  │
│  └──────────┘    │ WebRTC   │    └──────────┘  │
│                  │  :8889   │         │         │
│  ┌──────────┐    │ HLS      │    ┌──────────┐  │
│  │ 940nm IR │    │  :8888   │    │ Web App  │  │
│  │ LED (1W) │    │ RTSP     │    │ (static) │  │
│  │ always-on│    │  :8554   │    └──────────┘  │
│  └──────────┘    └──────────┘                   │
└─────────────────────────────────────────────────┘
         │                │
         ▼                ▼
   ┌──────────┐    ┌──────────┐
   │  Phone   │    │ Desktop  │
   │ (WebRTC) │    │ Browser  │
   └──────────┘    └──────────┘
```

**Streaming Protocols:**

| Protocol | Port | Latency | Use Case |
|----------|------|---------|----------|
| WebRTC | 8889 | ~200ms | Browser (primary) |
| HLS | 8888 | 2-5s | Mobile fallback |
| RTSP | 8554 | ~500ms | VLC, OBS, NVR |

---

## Step 1: Flash the OS

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choose OS: **Raspberry Pi OS Lite (64-bit)** — Bookworm
3. Click the gear icon (⚙) before writing to configure:
   - **Hostname:** `beatrix-cam`
   - **Enable SSH:** Yes (use password or key)
   - **Username:** `pi` (or your preference)
   - **Password:** Set a strong password
   - **Wi-Fi:** Enter your SSID and password
   - **Locale:** Set your timezone
4. Write to the microSD card
5. Insert the card into the Pi Zero 2W

---

## Step 2: Connect Hardware

1. **Camera Module 3** — Connect the ribbon cable to the Pi's camera port
   - Lift the connector latch gently
   - Insert the ribbon cable with contacts facing the board
   - Press the latch down to secure
2. **940nm IR LED** — Connect to a 5V power source (independent of Pi)
   - Position the LED to illuminate the enclosure evenly
   - The LED will be always-on when powered
3. **Power** — Connect the Pi to 5V USB-C power

---

## Step 3: Install

SSH into the Pi and run:

```bash
sudo apt update && sudo apt install -y git
git clone <your-repo-url> ~/beatrix-cam
cd ~/beatrix-cam
sudo bash setup.sh
```

That's it. The setup script handles everything:
- Installs and configures mediamtx (streaming server)
- Installs and configures nginx (web server)
- Creates systemd services for auto-start
- Configures the camera for optimal IR performance
- Opens necessary firewall ports

---

## Step 4: Watch

Once the setup completes and the Pi reboots:

| Method | URL |
|--------|-----|
| **Browser** | `http://beatrix-cam.local` |
| **Direct IP** | `http://<pi-ip-address>` |
| **VLC (RTSP)** | `rtsp://beatrix-cam.local:8554/beatrix` |

### Mobile Quick Access

1. Open `http://beatrix-cam.local` in your phone browser
2. Tap "Add to Home Screen" to install as an app
3. Launch from your home screen for a full-screen experience

> **Tip:** If `beatrix-cam.local` doesn't resolve, find the Pi's IP with:
> ```bash
> # On the Pi
> hostname -I
>
> # Or scan your network
> nmap -sn 192.168.1.0/24
> ```

---

## Configuration

### Video Settings

Edit `/opt/beatrix-cam/mediamtx.yml` to adjust:

```yaml
paths:
  beatrix:
    source: rpiCamera
    rpiCameraWidth: 1280       # Resolution width
    rpiCameraHeight: 720       # Resolution height
    rpiCameraFPS: 30           # Frame rate
    rpiCameraExposure: night   # Exposure mode
```

After changes: `sudo systemctl restart beatrix-cam`

### Available Resolutions

| Resolution | FPS | CPU Load | Recommended |
|------------|-----|----------|-------------|
| 640x480 | 30 | Low | Minimal bandwidth |
| 1280x720 | 30 | Medium | **Default (balanced)** |
| 1920x1080 | 15 | High | Maximum detail |

---

## Troubleshooting

### Camera not detected
```bash
# Check if camera is recognized
libcamera-hello --list-cameras

# Verify camera is enabled in boot config
grep -i camera /boot/firmware/config.txt
```

### Stream not loading
```bash
# Check mediamtx service status
sudo systemctl status beatrix-cam

# View streaming logs
sudo journalctl -u beatrix-cam -f

# Check nginx status
sudo systemctl status nginx

# Test camera directly
libcamera-vid -t 5000 -o test.h264
```

### Can't connect from phone
```bash
# Verify Pi is on the network
hostname -I

# Check if ports are open
ss -tlnp | grep -E '80|8554|8888|8889'

# Ensure mDNS is running (for .local resolution)
sudo systemctl status avahi-daemon
```

### High CPU / Overheating
- Reduce resolution to 640x480
- Lower FPS to 15
- Consider adding a heatsink to the Pi Zero 2W
- Ensure adequate ventilation

### IR image appears too bright/washed out
- Adjust IR LED distance from the enclosure
- Use a diffuser on the IR LED for even illumination
- Adjust camera exposure in mediamtx config:
  ```yaml
  rpiCameraExposure: normal
  rpiCameraGain: 8
  ```

---

## Service Management

```bash
# Stream service
sudo systemctl start beatrix-cam     # Start
sudo systemctl stop beatrix-cam      # Stop
sudo systemctl restart beatrix-cam   # Restart
sudo systemctl status beatrix-cam    # Status

# View logs
sudo journalctl -u beatrix-cam -f    # Follow logs
sudo journalctl -u beatrix-cam --since "1 hour ago"

# Web server
sudo systemctl restart nginx
```

---

## Network Ports

| Port | Protocol | Service | Purpose |
|------|----------|---------|---------|
| 80 | TCP | nginx | Web interface |
| 8554 | TCP | mediamtx | RTSP streaming |
| 8888 | TCP | mediamtx | HLS streaming |
| 8889 | TCP | mediamtx | WebRTC (WHEP) |
| 8189 | UDP | mediamtx | WebRTC ICE |
| 9997 | TCP | mediamtx | API |

---

## License

MIT

---

*Built with care for Beatrix (小脆) — because every snake deserves a comfortable, well-monitored home.*
