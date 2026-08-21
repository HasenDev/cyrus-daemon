class PanelClient {
    constructor(panelUrl, daemonToken) {
        this.panelUrl = panelUrl.replace(/\/+$/, '');
        this.daemonToken = daemonToken;
    }
    async fetchServers() {
        const url = `${this.panelUrl}/api/v1/daemon/servers`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.daemonToken}`,
                'Accept': 'application/json'
            }
        });

        if (!res.ok) {
            throw new Error(`Panel returned HTTP ${res.status} when syncing servers.`);
        }

        return await res.json();
    }
    async ackDeletions(clearedDeletions) {
        if (!Array.isArray(clearedDeletions) || clearedDeletions.length === 0) return;

        const url = `${this.panelUrl}/api/v1/daemon/servers`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.daemonToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ clearedDeletions })
        });

        if (!res.ok) {
            throw new Error(`Panel returned HTTP ${res.status} when acknowledging deletions.`);
        }

        return await res.json();
    }
}

module.exports = PanelClient;