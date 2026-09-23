FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8765

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# /data holds the SQLite database. Created here so a named volume starts out
# owned by the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8765
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/sorts').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
