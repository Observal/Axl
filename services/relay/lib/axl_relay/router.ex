# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.Router do
  @moduledoc "Plug boundary for WebSocket admission and authenticated revocation."

  import Plug.Conn

  @behaviour Plug
  @max_body_bytes 4_096

  @impl true
  def init(options), do: options

  @impl true
  def call(%{method: "GET", path_info: ["v1", "connect"]} = connection, options) do
    connection
    |> WebSockAdapter.upgrade(
      AxlRelay.Connection,
      Keyword.fetch!(options, :connection_options),
      compress: false,
      timeout: 60_000,
      max_frame_size: AxlRelay.Frame.max_frame_bytes()
    )
    |> halt()
  end

  def call(
        %{method: "POST", path_info: ["internal", "v1", "revocations"]} = connection,
        options
      ) do
    with {:ok, body, connection} <-
           read_body(connection, length: @max_body_bytes, read_length: @max_body_bytes),
         authenticator <- Keyword.fetch!(options, :internal_authenticator),
         true <-
           authenticator.authenticate(
             connection,
             body,
             Keyword.get(options, :internal_authenticator_options, [])
           ),
         {:ok, notification} <- AxlRelay.RevocationHandler.parse_notification(body),
         :ok <-
           AxlRelay.RouteRegistry.revoke(
             Keyword.get(options, :registry, AxlRelay.RouteRegistry),
             notification
           ) do
      json(connection, 200, %{"version" => 1, "accepted" => true})
    else
      false ->
        json(connection, 401, %{"error" => %{"code" => "unauthorized"}})

      {:more, _body, connection} ->
        json(connection, 413, %{"error" => %{"code" => "bad_request"}})

      _other ->
        json(connection, 400, %{"error" => %{"code" => "bad_request"}})
    end
  end

  def call(connection, _options) do
    status = if connection.method in ["GET", "POST"], do: 404, else: 405
    json(connection, status, %{"error" => %{"code" => "not_found"}})
  end

  defp json(connection, status, body) do
    encoded = body |> :json.encode() |> IO.iodata_to_binary()

    connection
    |> put_resp_header("cache-control", "no-store")
    |> put_resp_header("content-type", "application/json; charset=utf-8")
    |> put_resp_header("x-content-type-options", "nosniff")
    |> send_resp(status, encoded)
    |> halt()
  end
end
