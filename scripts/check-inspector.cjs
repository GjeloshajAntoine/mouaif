const fs = require('fs');
const files = fs.readdirSync('frontend/dist/assets').filter((f) => /^index-.*\.js$/.test(f));
for (const f of files) {
  const body = fs.readFileSync('frontend/dist/assets/' + f, 'utf8');
  console.log(f, 'bytes=' + body.length, 'hasCapture=' + body.includes('captureScreenshot'), 'hasPreview=' + body.includes('inspector__preview'));
}
const src = fs.readFileSync('frontend/src/components/Inspector.jsx', 'utf8');
console.log('src bytes=' + src.length, 'hasCapture=' + src.includes('captureScreenshot'));
