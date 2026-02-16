# Laplace Control Panel - TUI Manual
**Version 15.3 (Stable)**

## Introduction
The Terminal User Interface (TUI) allows administrators to manage the server instance directly from the command line/SSH session where the Node.js process is running. It provides full control over the lifecycle, configuration, and user management of the panel.

## Interactive Wizard
The `server create` command launches a strict, step-by-step wizard:

> **Note:** To prevent conflicts, the wizard will **block** creation if a server instance already exists. You must delete the existing server first using `server delete <name>`.

1.  **Name**: Alphanumeric (a-z, 0-9) and hyphens. Min 3 characters.
2.  **Path**: Absolute path to a valid `.jar` file (must exist on disk).
3.  **RAM**: Amount of memory (e.g., `4G`, `2048M`). Defaults to `4G` if empty.
4.  **Port**: Valid port number (1024-65535). Defaults to `25565`.
5.  **EULA**: Explicit acceptance required ('y' or 'n').

## Command Reference

### Server Management
*   **server create**
    *   Launches the server creation wizard. 
    *   *Restriction:* Fails if a server already exists.
*   **server delete <name>**
    *   Starts the deletion wizard for a server. Supports deleting or keeping backups.
*   **server start [id]**
    *   Starts the active server.
*   **server stop**
    *   Sends a stop command (via RCON or SIGTERM) to the running instance.
*   **server restart**
    *   Gracefully stops and restarts the instance.
*   **server status**
    *   Displays current CPU usage, uptime, player count, and active configuration ID.
*   **server console**
    *   Attaches to the live log stream. 
    *   *Input:* Type commands directly to send to Minecraft.
    *   *Exit:* Type `:q`, `menu`, or `detach` to return to the main menu.
*   **server list**
    *   Displays all registered servers in `laplace_data/servers`.
*   **server set <property> <value>**
    *   Quickly updates a property in `server.properties` (e.g. `server set max-players 10`).

### Web Interface (Plugin)
*   **webui port <number>**
    *   Changes the HTTP port for the web panel.
    *   *Requires Restart.*

### User Management (Panel Access)
*   **user list**
    *   Displays all registered users, roles, link count, and partial tokens.
*   **user add <username> <role>**
    *   Creates a new panel user.
    *   *Valid Roles:* `admin`, `user`, `guest`.
    *   *Validation:* Username must be alphanumeric/underscores (3+ chars).
*   **user del <username>**
    *   Permanently deletes a user. System Root cannot be deleted.
*   **user token <username>**
    *   Rotates the access token for a user and generates a new login link.
*   **user link <username> <provider> <value>**
    *   Links an external ID to a local user for remote authentication.
    *   *Example:* `user link admin discord 123456789`
    *   *Example:* `user link admin minecraft 550e8400-e29b...`
*   **user unlink <username> <provider>**
    *   Removes a linked external ID.

### Player Management (Minecraft)
*   **player list**
    *   Displays combined list of online, banned, and cached players.
*   **player info <name>**
    *   Shows detailed status, UUID, and flags for a specific player.
*   **player kick <name> [reason]**
    *   Kicks an online player.
*   **player ban <name> [reason]**
    *   Bans a player via the server's banlist.
*   **player unban <name>** (alias: **pardon**)
    *   Removes a player from the banlist.
*   **player op <name>**
    *   Grants Level 4 Operator status.
*   **player deop <name>**
    *   Revokes Operator status.
*   **player whitelist add <name>**
    *   Adds a player to the server whitelist.
*   **player unwhitelist <name>** (alias: **whitelist remove**)
    *   Removes a player from the server whitelist.

### Plugin System
*   **plugin list**
    *   Displays all currently loaded internal and external plugins with version info.

### System & Backups
*   **backup list**
    *   Lists available snapshots.
*   **backup create [name]**
    *   Creates a full copy of the server directory (skipping `session.lock`).
    *   *Requirement:* Server must be **OFFLINE**.
*   **backup restore <id>**
    *   Restores the snapshot. **Destructive Action**: Overwrites current files.
    *   *Requirement:* Server must be **OFFLINE**.
*   **backup delete <id>**
    *   Permanently deletes a snapshot.
*   **system exit** (or **exit**)
    *   Stops any running server and terminates the Node.js process gracefully.