# Docker test example

This small project is mounted read-only by `compose.test.yaml`. The smoke test registers it with mouaif, reads this file through the REST API, and creates an example chat in the isolated container data volume.

## Example

```js
const { greet } = require('./src/greeting.js');
console.log(greet('Docker'));
```
