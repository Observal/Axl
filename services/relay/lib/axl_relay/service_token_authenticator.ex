# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.ServiceTokenAuthenticator do
  @moduledoc """
  Bearer authentication of the control plane's calls into the relay, with a service token from
  Secrets Manager. No client holds it.
  """

  @behaviour AxlRelay.InternalAuthenticator

  @impl true
  def authenticate(connection, _body, options) do
    with expected when is_binary(expected) and byte_size(expected) >= 32 <-
           Keyword.get(options, :token),
         [actual] <- Plug.Conn.get_req_header(connection, "authorization") do
      secure_equal(actual, "Bearer " <> expected)
    else
      _other -> false
    end
  end

  defp secure_equal(left, right) when byte_size(left) == byte_size(right),
    do: :crypto.hash_equals(left, right)

  defp secure_equal(_left, _right), do: false
end
