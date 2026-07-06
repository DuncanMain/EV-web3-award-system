# Node.js Docker image for NVF Award Core
FROM node:20-alpine AS build

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json .
COPY src ./src
COPY .env.example ./

RUN npm run build

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM node:20-alpine AS runtime
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/frontend/dist ./frontend/dist
COPY .env.example ./

EXPOSE 3000

CMD ["sh", "-c", "node dist/database/migrate.js && node dist/api.js"]
