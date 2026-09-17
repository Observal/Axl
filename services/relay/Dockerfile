# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

FROM hexpm/elixir:1.18.5-erlang-27.3.4.17-alpine-3.22.5@sha256:d341d0393ae82d959ae02e18af47591b44de87b5926b3b9b6c7e882b1cba5f6a AS build
RUN apk add --no-cache build-base git
ENV MIX_ENV=prod
WORKDIR /workspace
RUN mix local.hex --force && mix local.rebar --force
COPY services/relay/mix.exs services/relay/mix.lock ./
RUN mix deps.get --only prod && mix deps.compile
COPY services/relay/config ./config
COPY services/relay/lib ./lib
RUN mix compile && mix release

FROM hexpm/elixir:1.18.5-erlang-27.3.4.17-alpine-3.22.5@sha256:d341d0393ae82d959ae02e18af47591b44de87b5926b3b9b6c7e882b1cba5f6a AS runtime
RUN apk add --no-cache ca-certificates libstdc++ ncurses-libs openssl
ENV HOME=/app PORT=4000
WORKDIR /app
COPY --from=build /workspace/_build/prod/rel/axl_relay ./
RUN chown -R nobody:nobody /app
USER nobody
EXPOSE 4000
CMD ["bin/axl_relay", "start"]
