# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.Listener do
  @moduledoc "Configured Bandit listener for the relay's public and internal boundaries."

  def child_spec(options) do
    Bandit.child_spec(bandit_options(options))
  end

  def start_link(options) do
    Bandit.start_link(bandit_options(options))
  end

  defp bandit_options(options) do
    [
      plug:
        {AxlRelay.Router,
         [
           connection_options: Keyword.fetch!(options, :connection_options),
           internal_authenticator: Keyword.fetch!(options, :internal_authenticator),
           internal_authenticator_options:
             Keyword.get(options, :internal_authenticator_options, []),
           registry: Keyword.get(options, :registry, AxlRelay.RouteRegistry)
         ]},
      scheme: Keyword.get(options, :scheme, :https),
      ip: Keyword.get(options, :ip, {127, 0, 0, 1}),
      port: Keyword.fetch!(options, :port),
      startup_log: false
    ]
  end
end
