FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

# DATABASE_URL, SESSION_SECRET, ADMIN_USERNAME y ADMIN_PASSWORD deben definirse
# como variables de entorno de la plataforma de despliegue (apuntando a tu base de Neon).
CMD ["sh", "-c", "node src/seed.js && node src/server.js"]
