// Generate PWA icons for WPS Staff Hub
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size, outputPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background - navy
  ctx.fillStyle = '#1E2A5E';
  ctx.fillRect(0, 0, size, size);

  // Gold circle
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#FFD700';
  ctx.fill();

  // Navy inner circle
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
  ctx.fillStyle = '#1E2A5E';
  ctx.fill();

  // Text "WPS" in gold
  ctx.fillStyle = '#FFD700';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${size * 0.22}px Arial`;
  ctx.fillText('WPS', cx, cy - size * 0.05);

  // Smaller text "HUB"
  ctx.font = `bold ${size * 0.11}px Arial`;
  ctx.fillText('HUB', cx, cy + size * 0.12);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated ${outputPath} (${size}x${size})`);
}

const iconsDir = path.join(__dirname, 'public', 'icons');
generateIcon(192, path.join(iconsDir, 'icon-192.png'));
generateIcon(512, path.join(iconsDir, 'icon-512.png'));
console.log('Icons generated!');
