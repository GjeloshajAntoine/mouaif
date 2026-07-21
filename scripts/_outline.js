const fs = require('fs');
const lines = fs.readFileSync('src/index.js', 'utf8').split('\n');
console.log('lines:', lines.length);
lines.forEach((l, i) => {
  if (/^\/\/ ----|^\/\/ ===|^function |^async function |^const .*require|server\.(get|post|patch|delete|put)|app\.(get|post|patch|delete|put)|if \(url ===|if \(path ===|method ===/.test(l)) {
    console.log((i + 1) + ': ' + l.trim().slice(0, 100));
  }
});
