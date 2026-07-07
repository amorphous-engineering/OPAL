/**
 * OPAL Real-time Events Client
 *
 * Provides SSE-based real-time updates for execution collaboration.
 * Handles step updates, user presence, and collaboration events.
 */

class OpalEvents {
    constructor() {
        this.eventSource = null;
        this.listeners = {};
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.heartbeatInterval = null;
        this.currentActivity = null;
    }

    /**
     * Connect to the SSE event stream
     */
    connect() {
        if (this.eventSource) {
            this.disconnect();
        }

        if (!window.OPAL_USER_ID) {
            console.warn('OpalEvents: not signed in, skipping SSE connection');
            return;
        }

        const url = `/api/events/stream`;
        this.eventSource = new EventSource(url);

        this.eventSource.onopen = () => {
            console.log('OpalEvents: Connected to event stream');
            this.reconnectAttempts = 0;
            this.emit('connected');
        };

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleEvent(data);
            } catch (e) {
                console.error('OpalEvents: Failed to parse event', e);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('OpalEvents: Connection error', error);
            this.eventSource.close();
            this.eventSource = null;
            this.emit('disconnected');
            this.attemptReconnect();
        };

        // Start heartbeat
        this.startHeartbeat();
    }

    /**
     * Disconnect from the SSE event stream
     */
    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.stopHeartbeat();
        this.emit('disconnected');
    }

    /**
     * Attempt to reconnect after connection failure
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn('OpalEvents: Max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        console.log(`OpalEvents: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    /**
     * Handle incoming events
     */
    handleEvent(event) {
        const { type, data, timestamp } = event;

        // Emit to specific listeners
        this.emit(type, data, timestamp);

        // Emit to global 'event' listener
        this.emit('event', event);
    }

    /**
     * Add event listener
     */
    on(eventType, callback) {
        if (!this.listeners[eventType]) {
            this.listeners[eventType] = [];
        }
        this.listeners[eventType].push(callback);
        return () => this.off(eventType, callback);
    }

    /**
     * Remove event listener
     */
    off(eventType, callback) {
        if (this.listeners[eventType]) {
            this.listeners[eventType] = this.listeners[eventType].filter(cb => cb !== callback);
        }
    }

    /**
     * Emit event to listeners
     */
    emit(eventType, ...args) {
        const callbacks = this.listeners[eventType] || [];
        callbacks.forEach(cb => {
            try {
                cb(...args);
            } catch (e) {
                console.error(`OpalEvents: Error in ${eventType} listener`, e);
            }
        });
    }

    /**
     * Start periodic heartbeat
     */
    startHeartbeat() {
        this.stopHeartbeat();

        // Send heartbeat every 15 seconds
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, 15000);

        // Send initial heartbeat
        this.sendHeartbeat();
    }

    /**
     * Stop heartbeat
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Send heartbeat to server
     */
    async sendHeartbeat() {
        if (!window.OPAL_USER_ID) return;

        try {
            const response = await fetch('/api/users/heartbeat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    activity: this.currentActivity,
                }),
            });

            if (!response.ok) {
                console.warn('OpalEvents: Heartbeat failed', response.status);
            }
        } catch (e) {
            console.error('OpalEvents: Heartbeat error', e);
        }
    }

    /**
     * Update current activity (shown to other users)
     */
    setActivity(activity) {
        this.currentActivity = activity;
        this.sendHeartbeat();
    }

    /**
     * Check if connected
     */
    get isConnected() {
        return this.eventSource && this.eventSource.readyState === EventSource.OPEN;
    }
}

// Global instance
window.opalEvents = new OpalEvents();

// Auto-connect on page load if user is set
document.addEventListener('DOMContentLoaded', () => {
    if (window.OPAL_USER_ID) {
        window.opalEvents.connect();
    }
});

// Disconnect on page unload
window.addEventListener('beforeunload', () => {
    window.opalEvents.disconnect();
});
