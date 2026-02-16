import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { LaplaceContext, LaplacePlugin, PluginMetadata } from '../../types.ts';

export class Plugin {
    private pluginsDir: string;
    private context: LaplaceContext;
    private loadedPlugins: Map<string, LaplacePlugin> = new Map();

    constructor(pluginsDir: string, context: LaplaceContext) {
        this.pluginsDir = pluginsDir;
        this.context = context;

        if (!fs.existsSync(this.pluginsDir)) {
            fs.mkdirSync(this.pluginsDir, { recursive: true });
        }
    }

    public async loadInternalPlugins(plugins: LaplacePlugin[]) {
        if (!plugins || plugins.length === 0) {
            this.context.logger('[Plugins] Warning: No internal plugins provided to loader.');
            return;
        }
        
        for (const plugin of plugins) {
            try {
                // Pre-check name for logging
                const nameCheck = (plugin.metadata && plugin.metadata.name) ? plugin.metadata.name : 'Unknown Plugin';
                this.context.logger(`[Plugins] Loading internal module: ${nameCheck}...`);
                
                await plugin.onLoad(this.context);
                
                // Robust Registration Logic
                if (plugin.metadata && plugin.metadata.name) {
                    this.loadedPlugins.set(plugin.metadata.name, plugin);
                    this.context.logger(`[Plugins] Internal module registered: ${plugin.metadata.name}`);
                } else {
                    // Fallback: If onLoad succeeded but metadata is missing, register it anyway with a unique ID
                    const fallbackName = `Unnamed-Plugin-${Date.now()}`;
                    this.loadedPlugins.set(fallbackName, {
                        ...plugin,
                        metadata: { 
                            name: fallbackName, 
                            version: '0.0.0', 
                            description: 'Metadata missing but loaded successfully.' 
                        }
                    });
                    this.context.logger(`[Plugins] Warning: Plugin loaded but metadata is missing. Registered as '${fallbackName}'.`, 'warn');
                }
            } catch (e: any) {
                this.context.logger(`[Plugins] Failed to load internal module: ${e.message}`, 'error');
                console.error(e);
            }
        }
    }

    public async loadAll() {
        this.context.logger('[Plugins] Scanning for external plugins...');
        
        try {
            const items = fs.readdirSync(this.pluginsDir);
            if (items.length === 0) {
                return;
            }

            for (const item of items) {
                const pluginPath = path.join(this.pluginsDir, item);
                if (fs.statSync(pluginPath).isDirectory()) {
                    await this.loadPlugin(pluginPath);
                }
            }
        } catch (e: any) {
            this.context.logger(`[Plugins] Scan failed: ${e.message}`, 'error');
        }
    }

    private async loadPlugin(dirPath: string) {
        // Look for index.js or index.mjs
        let entryPoint = path.join(dirPath, 'index.js');
        if (!fs.existsSync(entryPoint)) {
            entryPoint = path.join(dirPath, 'index.mjs');
            if (!fs.existsSync(entryPoint)) {
                return; // Silently skip directories without entry points
            }
        }

        try {
            // Dynamic Import
            const importUrl = pathToFileURL(entryPoint).href;
            const module = await import(importUrl);
            
            // Expect default export to be a class or object structure matching interface
            const PluginClass = module.default;
            
            if (!PluginClass) {
                throw new Error("Plugin must have a default export");
            }

            // Instantiate if it's a class, otherwise use as object
            let pluginInstance: LaplacePlugin;
            try {
                pluginInstance = new PluginClass();
            } catch {
                pluginInstance = PluginClass as LaplacePlugin;
            }

            // Validation
            if (!pluginInstance.onLoad) {
                throw new Error("Invalid plugin structure. Missing onLoad method.");
            }

            // Execution
            await pluginInstance.onLoad(this.context);
            
            const metaName = pluginInstance.metadata?.name || `Ext-Plugin-${path.basename(dirPath)}`;
            
            if (!pluginInstance.metadata) {
                 pluginInstance.metadata = { name: metaName, version: '1.0', description: 'No metadata provided' };
            }

            this.loadedPlugins.set(metaName, pluginInstance);
            this.context.logger(`[Plugins] Loaded external: ${metaName}`);

        } catch (e: any) {
            this.context.logger(`[Plugins] Failed to load ${path.basename(dirPath)}: ${e.message}`, 'error');
        }
    }

    public getPlugin(name: string): LaplacePlugin | undefined {
        return this.loadedPlugins.get(name);
    }

    public getLoadedPlugins(): PluginMetadata[] {
        // Explicitly return metadata array for TUI consumption
        // Use Array.from to ensure we get a clean array from the Map values
        return Array.from(this.loadedPlugins.values()).map(p => p.metadata);
    }
}