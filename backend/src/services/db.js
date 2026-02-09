const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class DBService {
    constructor() {
        this.dataDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    getFilePath(collection) {
        return path.join(this.dataDir, `${collection}.json`);
    }

    async readData(collection) {
        const filePath = this.getFilePath(collection);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const data = await fs.promises.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.error(`Error reading ${collection}:`, error);
            return [];
        }
    }

    async writeData(collection, data) {
        const filePath = this.getFilePath(collection);
        try {
            await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (error) {
            logger.error(`Error writing ${collection}:`, error);
            return false;
        }
    }

    async getAll(collection) {
        return await this.readData(collection);
    }

    async save(collection, item) {
        const data = await this.readData(collection);
        // Check if item exists (update) or is new (insert)
        const index = data.findIndex(d => d.id === item.id);

        if (index > -1) {
            data[index] = { ...data[index], ...item };
        } else {
            data.push(item);
        }

        await this.writeData(collection, data);
        return item;
    }

    // Bulk save (replace all) - useful for initial sync or full updates
    async saveAll(collection, items) {
        await this.writeData(collection, items);
        return items;
    }

    async delete(collection, id) {
        let data = await this.readData(collection);
        const initialLength = data.length;
        data = data.filter(d => d.id !== parseInt(id));

        if (data.length !== initialLength) {
            await this.writeData(collection, data);
            return true;
        }
        return false;
    }
}

module.exports = new DBService();
