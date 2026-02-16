# Laplace Control Panel - API Reference
**Version 15.2 (Stable)**

## Overview
All API endpoints are served relative to the panel port (default `11228`).
*   **Base URL:** `http://localhost:11228/api`
*   **Authentication:** 
    *   **Header:** `x-auth-token: <type>@<value>`
    *   **Query Param:** `?token=<type>@<value>`

## Authentication Format

The API now uses a composite token format to support multiple authentication providers (Internal, Discord, Minecraft, etc.).

**Format:** `type@value`

| Part | Description |
| :--- | :--- |
| `type` | The provider ID. Default is `laplace`. External providers match keys in `externalIds`. |
| `@` | Separator. |
| `value` | The actual token string or external ID. |

**Examples:**
1.  **Standard Admin Token:** `laplace@550e8400-e29b-41d4-a716-446655440000`
2.  **Linked Discord Account:** `discord@123456789012345678`
3.  **Linked Minecraft Account:** `minecraft@550e8400-e29b-41d4-a716-446655440000`

If the `@` separator is missing, the system defaults to type `laplace`.

## Command Line Interaction (cURL)

### Examples

**1. Check Server Status (Standard Token)**
```bash
curl -H "x-auth-token: laplace@YOUR_ADMIN_TOKEN" http://localhost:11228/api/server/status
```

**2. Check Server Status (External ID)**
```bash
# Assuming user linked 'discord' with ID '12345'
curl -H "x-auth-token: discord@12345" http://localhost:11228/api/server/status
```

**3. Start the Server**
```bash
curl -X POST \
  -H "x-auth-token: laplace@YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:11228/api/server/start
```

**4. Execute Player Action**
```bash
curl -X POST \
  -H "x-auth-token: laplace@YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Steve", "action": "ban", "payload": "Griefing"}' \
  http://localhost:11228/api/players/action
```

## Error Handling
Standard HTTP Codes:
*   `200 OK`: Success.
*   `400 Bad Request`: Invalid input parameters.
*   `401 Unauthorized`: Missing token header.
*   `403 Forbidden`: Invalid credential or user not found.
*   `500 Internal Server Error`: Logic failure.

## Endpoints

### Authentication
#### GET /auth/check
Validates the current token.
*   **Headers:** `x-auth-token`
*   **Response:** `{ success: true, data: { valid: true, isAdmin: boolean, user: Object } }`

### Server Control
#### GET /public/info
Publicly accessible status endpoint (no auth required).
*   **Response:** JSON object with MOTD, online count, core type, and version.

#### GET /server/status
Returns internal status state.
*   **Response:** `{ running: boolean, status: string, activeServerId: string }`

#### POST /server/start
Initiates startup sequence.
*   **Body:** `{ serverId?: string }` (Optional, defaults to active)

#### POST /server/stop
Sends stop signal.

#### GET /server/settings
Retrieves current configuration.
*   **Response:** `{ config: Object, properties: Object }`

#### POST /server/settings
Updates configuration.
*   **Body:** `{ config: ServerConfig, properties: Record<string, string> }`

### File Management
#### GET /files/list
*   **Query:** `?path=/`
*   **Response:** Array of file objects (name, size, isDirectory).

#### GET /files/content
*   **Query:** `?path=/server.properties`
*   **Response:** `{ content: string }`

#### POST /files/write
*   **Body:** `{ path: string, content: string }`

### Player Management
#### GET /players
Returns aggregated player list.

#### POST /players/action
Executes administrative actions.
*   **Body:** `{ name: string, action: 'kick'|'ban'|'op'|..., payload?: string }`

### Backup System
#### GET /backups
Lists all backups for the active server.

#### POST /backups/create
Creates a new snapshot.
*   **Body:** `{ name?: string }`
*   **Note:** Server must be offline.

#### POST /backups/restore
Restores a snapshot.
*   **Body:** `{ id: string }`
*   **Note:** Server must be offline.