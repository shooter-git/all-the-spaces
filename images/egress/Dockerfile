# syntax=docker/dockerfile:1.7
# The egress proxy: the only way out of an Architect's sandbox. No dependencies, no secrets.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY apps/egress/src ./src
COPY deploy/egress/allow.txt /etc/egress/allow.txt
COPY deploy/egress/deny.txt /etc/egress/deny.txt
ENV EGRESS_ALLOW_FILE=/etc/egress/allow.txt EGRESS_DENY_FILE=/etc/egress/deny.txt EGRESS_PORT=3128
USER node
EXPOSE 3128
CMD ["node", "src/main.ts"]
