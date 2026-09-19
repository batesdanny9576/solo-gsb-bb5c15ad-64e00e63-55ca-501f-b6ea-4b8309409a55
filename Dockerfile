FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先拷贝依赖清单，利用镜像层缓存；依赖安装纳入镜像构建
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝应用代码与前端静态资源
COPY server.js ./
COPY public ./public

EXPOSE 3000

# 启动即完成初始化（无需额外命令）
CMD ["node", "server.js"]
