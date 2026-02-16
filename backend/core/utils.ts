import fs from 'fs';
import path from 'path';

export function writeJsonAtomic(filePath: string, data: any) {
    const tmpPath = `${filePath}.tmp`;
    const content = JSON.stringify(data, null, 2);
    
    try {
        fs.writeFileSync(tmpPath, content, 'utf-8');
        fs.renameSync(tmpPath, filePath);
    } catch (e) {
        console.error(`[System] Atomic write failed for ${filePath}:`, e);
        throw e;
    }
}

export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
    if (!fs.existsSync(filePath)) return defaultValue;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return defaultValue;
        return JSON.parse(content) as T;
    } catch (e) {
        console.error(`[System] Warning: Failed to parse JSON at ${filePath}. Using default value. Error: ${(e as Error).message}`);
        try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch {}
        return defaultValue;
    }
}