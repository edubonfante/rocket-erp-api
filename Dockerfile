FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (cache de camadas)
COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

# Cria pasta de logs
RUN mkdir -p logs

# Usuário não-root por segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "src/index.js"]
