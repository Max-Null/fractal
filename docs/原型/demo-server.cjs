// 临时 demo 静态服务（载入页 Demo 预览用）：node demo-server.cjs 8899
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(process.cwd(), 'docs', '原型');
const port = Number(process.argv[2] || 8899);
http.createServer((req, res) => {
  try {
    let f = decodeURIComponent(req.url.split('?')[0]);
    if (f === '/') f = '/载入页-demo.html';
    const b = fs.readFileSync(path.join(root, f));
    res.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
    res.end(b);
  } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(port, () => console.log(`demo server on ${port}`));
