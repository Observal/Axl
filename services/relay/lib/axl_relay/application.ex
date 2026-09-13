# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      case Application.get_env(:axl_relay, :listener_options) do
        nil -> [AxlRelay.RouteRegistry]
        options -> [AxlRelay.RouteRegistry, {AxlRelay.Listener, options}]
      end

    Supervisor.start_link(children, strategy: :one_for_one, name: AxlRelay.Supervisor)
  end
end
