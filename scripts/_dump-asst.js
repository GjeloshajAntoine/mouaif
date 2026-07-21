const fs = require('fs');
const file = process.argv[2];
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const m of d.messages) {
  if (m.role === 'assistant') {
    console.log('---');
    console.log('content:', (m.content || '').slice(0, 50).replace(/\n/g, ' '));
    console.log('usage:', JSON.stringify(m.usage));
    console.log('cost:', JSON.stringify(m.cost));
    console.log('modelId:', m.modelId);
  }
}
