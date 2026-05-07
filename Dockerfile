# Node.js Docker image for NVF Award Core
FROM node:20-alpine AS build

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json .
COPY src ./src
COPY .env.example ./

RUN npm run build

# Build frontend
FROM node:20-alpine AS frontend-build

WORKDIR /usr/src/app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY --from=build /usr/src/app/dist ./dist
COPY .env.example ./
COPY --from=frontend-build /usr/src/app/frontend/dist ./frontend/dist

EXPOSE 3000

CMD ["node", "dist/api.js"]
