FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/imorat.db UPLOADS_DIR=/data/uploads
COPY package.json ./
COPY src ./src
COPY data/catalog.json ./data/catalog.json
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
