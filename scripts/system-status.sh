#!/bin/bash
# System status for NanoClaw agent
echo "=== CPU ==="
echo "Load: $(cat /proc/loadavg | cut -d' ' -f1-3)"
echo "Usage: $(top -bn1 | grep 'Cpu(s)' | awk '{print 100 - $8}')%"
echo "Temp: $(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -rn | head -1 | awk '{printf "%.1f°C", $1/1000}')"
echo ""
echo "=== Memory ==="
free -h | awk '/^Mem:/{printf "RAM: %s used / %s total (%s available)\n", $3, $2, $7}'
echo ""
echo "=== GPU (AMD) ==="
GPU_TEMP=$(cat /sys/class/drm/card*/device/hwmon/hwmon*/temp1_input 2>/dev/null | head -1)
GPU_BUSY=$(cat /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null | head -1)
GPU_VRAM_USED=$(cat /sys/class/drm/card*/device/mem_info_vram_used 2>/dev/null | head -1)
GPU_VRAM_TOTAL=$(cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null | head -1)
[ -n "$GPU_TEMP" ] && echo "Temp: $(awk "BEGIN{printf \"%.0f°C\", $GPU_TEMP/1000}")"
[ -n "$GPU_BUSY" ] && echo "Usage: ${GPU_BUSY}%"
if [ -n "$GPU_VRAM_USED" ] && [ -n "$GPU_VRAM_TOTAL" ]; then
    echo "VRAM: $(awk "BEGIN{printf \"%.1fGB / %.1fGB\", $GPU_VRAM_USED/1073741824, $GPU_VRAM_TOTAL/1073741824}")"
fi
echo ""
echo "=== Disk ==="
df -h / | awk 'NR==2{printf "%s used / %s total (%s free)\n", $3, $2, $4}'
echo ""
echo "=== Ollama ==="
ollama ps 2>/dev/null || echo "Not running"
