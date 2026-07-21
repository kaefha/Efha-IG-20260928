const fs = require('fs');
const path = require('path');

const ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXUpAAAACXBIWXMAAAsTAAALEwEAmpwYAAAEfElEQVR4nO2b32sTQRDFP5q+pGnTpq1/VGlFsFpEsKAPKgj6VxXF50L1qf/GP9Vn9U3fVPBB/VNBsCA+VFCxFQp+iU2Tpk3TvqSPG3ZyO5vM3exmdtOHBwubm8zd797uzs7ODqKqqqri1q8a9gD7gH3AfmDfbTj/F491Ew9fAEvAHWAJuAGs9rO4t2Q2P4l5pAGcAI6Yx9N/8f41UAIqfSyqP2g2u13UwwRQA4rmcTz391WAC2wCR/pU5F/l3HwHWAaWDcc8s/kOMAzMAIcGXGzvcNwcqACqG8Hh6sIxs2sBqAA3zbG/w3FvoAKorwPHTdE4bvbTAyVg2XzQv6u5B3pAGVj26ZhnNu+qADeB5f/4YJqJtP2C72y27QG2Wn6sD1o1E5n/C/W2PWCj5e92mXv2X9y7Z99n/7e5f+dO+9gD/qYHrLT03x7w/y/X795pH3vAX3vA/x13D1j02L0eD3Bv8cIerwe4txz1eIB7yw2P3evxAPfWgx4PcB+5v93D/xHw5/fAPmAfcO/zD+WwUuWJqXo9zM7w53zM/t2d5s95O+N+z9kZ9l2+O+t+z6c97g94Os2f8z7n/r11jv1jns6w7/P1dfZdnvaxf4xXm1Oemc+j9fX2e3zZ5P4p73vs7/F9kvtTvP3E/nvP+w94O31DntXp0143890l3nfxDnv4Zzw9e7zR3/Z6H+8z4P9/1N/2ehvvM37299w/6p322cM/7bPv3rF/1Dvrs7uT3mkvwL/WexvPezg5dffW/k772D/C4x3uH+LxR/0H/xH0D009sB+wH7AfcOqB/YD9gP2Az4W4XU2Lpxo8v8f7eNf9dGfUf4p3Z/h7Pst2hjt37g3y25o7t+b+o6b7x23y9/2wL+Gv/o0F+L+A3Gj5u92eH+n9bV+G/bV3G/a/sX/Iq83+D/62d/5v8H/2N1r+bq/nR/pXf05v8G/w992wL/r33Q+s93sW/T3r/c+s/5n1X2/P/p5l/0v7R7wT/W3v2P/SvnH+3P4h52e50/f0d+1/6W93v4Dfv5g/eP9Rz0/v+57+Yv6O/hL+Yv7gff/R61P371/2v/S/Xj/S/1L/B/41/pZ7+oP+Ev519v2v3f9+t0fdz5+x/x/9Qy403L8M/2Gv/7f9Dff0h/2t/W7+z/z/8zP9Hfg/+/vv6W/w3/8t/s/8T/kP+Uf9F/wN9/QH/V7+r5r2Q/6/9P//w95rVw/5/4X+9v/1pvsV/sBfc3/g/+v/n8P/Xv9//y15f5b/3P/k/+t/f6e/3f9n/jP+Bf/Gf5H3t72t9f5V/s9f3+Uf+H/Xf//9XfsV/k3/V/hX/s9//3X+Vf/R/nvv6W/6W9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U9/U5/U5/U5/U5/U5/U5/U5/U5/U5/U5/U5/U5/U5/U5/U5/U9+2t/Wv+m9+2X/Wf9ff1ff1ff1ff1ff1ff1ff1ff1ff1ff1ff1ff1ff1/a3/tX9f/5n/X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X39X9t/6+3f5/9rWv/4X9N/+99rf3vtb397f2/bXtrW3trW1rb2vbWtra1trWtta29re17f2+Xtr217b1v/4X/sf0//r7e/n/8rW//hf6a+lv/Ynpa2lrb/wM1r2z/wN1r+zf6tq2n2k+hvg/Q/wfQ3wXoD8F9A/DfQPwXsD8F7G//b/v8/sAAAAASUVORK5CYII=';

const iconsDir = path.join(__dirname, 'icons');

// Create icons directory if it doesn't exist
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Convert base64 string to buffer
const imageBuffer = Buffer.from(ICON_BASE64, 'base64');

// Write the image buffer to the three target file sizes
const sizes = [16, 48, 128];
sizes.forEach(size => {
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, imageBuffer);
  console.log(`Successfully created: ${filePath}`);
});

console.log('All extension icons generated successfully.');
