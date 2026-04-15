FROM node:24-bookworm-slim AS build

WORKDIR /app/frontend
ARG FRONTEND_BUILD_COMMIT=local
ARG FRONTEND_BUILD_DATE=unknown

COPY frontend/package*.json ./
RUN npm ci

COPY frontend ./
RUN FRONTEND_BUILD_COMMIT_VALUE="${FRONTEND_BUILD_COMMIT}"; \
  FRONTEND_BUILD_DATE_VALUE="${FRONTEND_BUILD_DATE}"; \
  if [ -z "${FRONTEND_BUILD_COMMIT_VALUE}" ]; then FRONTEND_BUILD_COMMIT_VALUE="local"; fi; \
  if [ -z "${FRONTEND_BUILD_DATE_VALUE}" ] || [ "${FRONTEND_BUILD_DATE_VALUE}" = "unknown" ]; then FRONTEND_BUILD_DATE_VALUE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; fi; \
  cat > /app/frontend/src/app/config/build-info.ts <<EOF
export interface FrontendBuildInfo {
  commit : string;
  builtAtUtc : string;
}

export const BUILD_INFO : FrontendBuildInfo = {
  commit: '${FRONTEND_BUILD_COMMIT_VALUE}',
  builtAtUtc: '${FRONTEND_BUILD_DATE_VALUE}',
};
EOF
RUN npm run build

FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist/frontend/browser /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
