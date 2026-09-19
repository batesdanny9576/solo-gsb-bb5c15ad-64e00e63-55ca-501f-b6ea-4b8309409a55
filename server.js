'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 静态资源（前端页面、引擎、示例文件）
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'srt-timeline-editor', time: new Date().toISOString() });
});

// 单页应用回退：其余路径均返回首页
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SRT 时间轴修整器已启动: http://localhost:${PORT}`);
});
