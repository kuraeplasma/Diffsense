const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
    logger.error('Error occurred:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method
    });

    // Default error
    let statusCode = 500;
    let message = 'Internal server error';

    // Handle specific error types
    if (err.name === 'ValidationError') {
        statusCode = 400;
        message = err.message;
    } else if (err.message.includes('PDF')) {
        statusCode = 400;
        message = err.message;
    } else if (err.message.includes('URL')) {
        statusCode = 400;
        message = err.message;
    } else if (err.response?.status === 429) {
        statusCode = 429;
        message = 'AI API rate limit exceeded. Please try again later.';
    } else if (err.code === 'ECONNABORTED') {
        statusCode = 504;
        message = 'AI analysis timeout. Please try again.';
    }

    res.status(statusCode).json({
        success: false,
        error: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
}

module.exports = errorHandler;
