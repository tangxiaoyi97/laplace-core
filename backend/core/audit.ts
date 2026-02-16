import fs from 'fs';
import path from 'path';

export class Audit {
    private auditDir: string;

    constructor(dataDir: string) {
        this.auditDir = path.join(dataDir, 'audit');
        if (!fs.existsSync(this.auditDir)) {
            fs.mkdirSync(this.auditDir, { recursive: true });
        }
    }

    public log(actionType: string, username: string, description: string) {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const logFile = path.join(this.auditDir, `${dateStr}.log`);
        
        const timeStr = now.toLocaleTimeString();
        const logLine = `[${timeStr}] [${actionType.toUpperCase()}] ${username}: ${description}\n`;

        try {
            fs.appendFileSync(logFile, logLine);
        } catch (e) {
            console.error(`[Audit] Failed to write log:`, e);
        }
    }
}