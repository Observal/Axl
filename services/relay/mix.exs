# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.MixProject do
  use Mix.Project

  def project do
    [
      app: :axl_relay,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      dialyzer: [plt_add_apps: [:bandit, :inets, :ssl]]
    ]
  end

  def application do
    [
      extra_applications: [:logger, :inets, :ssl],
      mod: {AxlRelay.Application, []}
    ]
  end

  defp deps do
    [
      {:bandit, "1.12.5"},
      {:plug, "1.20.3"},
      {:websock_adapter, "0.6.0"},
      {:credo, "1.7.12", only: [:dev, :test], runtime: false},
      {:dialyxir, "1.4.6", only: [:dev, :test], runtime: false},
      {:mix_audit, "2.1.5", only: [:dev, :test], runtime: false}
    ]
  end
end
