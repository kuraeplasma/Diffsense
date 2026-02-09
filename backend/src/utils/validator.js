const Joi = require('joi');

const analyzeRequestSchema = Joi.object({
    contractId: Joi.number().integer().required(),
    method: Joi.string().valid('pdf', 'url', 'text').required(),
    source: Joi.string().required(),
    previousVersion: Joi.string().optional().allow(null, '')
});

function validateAnalyzeRequest(data) {
    return analyzeRequestSchema.validate(data);
}

module.exports = {
    validateAnalyzeRequest
};
