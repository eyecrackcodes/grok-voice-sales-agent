FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY sim ./sim
COPY data/leads.example.csv ./data/leads.example.csv
ENV HOST=0.0.0.0 PORT=4319
EXPOSE 4319
CMD ["node", "src/server.mjs"]
