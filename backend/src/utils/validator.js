const Joi = require('joi');

const analyzeRequestSchema = Joi.object({
    contractId: Joi.number().integer().required(),
    method: Joi.string().valid('pdf', 'url', 'text', 'docx').required(),
    source: Joi.string().required(),
    previousVersion: Joi.alternatives().try(
        Joi.string(),
        Joi.array(),
        Joi.object()
    ).optional().allow(null, ''),
    skipAI: Joi.boolean().optional()
});

function validateAnalyzeRequest(data) {
    return analyzeRequestSchema.validate(data);
}

module.exports = {
    validateAnalyzeRequest
};
