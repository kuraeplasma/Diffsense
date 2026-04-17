(function (window) {
    'use strict';

    var ALL_ATTR_KEYS = [
        'gclid',
        'wbraid',
        'gbraid',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_term',
        'utm_content'
    ];
    var CLICK_ATTR_KEYS = ['gclid', 'wbraid', 'gbraid'];

    function safeGet(storage, key) {
        try {
            return storage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function safeSet(storage, key, value) {
        try {
            storage.setItem(key, value);
        } catch (_) {
            // Ignore storage write failures (private mode, blocked storage, etc.).
        }
    }

    function persistAttributionFromUrl() {
        var params = new URLSearchParams(window.location.search || '');
        for (var i = 0; i < ALL_ATTR_KEYS.length; i += 1) {
            var key = ALL_ATTR_KEYS[i];
            var value = params.get(key);
            if (!value) continue;
            var storageKey = 'attr_' + key;
            safeSet(window.localStorage, storageKey, value);
            safeSet(window.sessionStorage, storageKey, value);
        }
    }

    function getStoredAttributionValue(key) {
        var params = new URLSearchParams(window.location.search || '');
        var fromUrl = params.get(key);
        if (fromUrl) return fromUrl;

        var storageKey = 'attr_' + key;
        return (
            safeGet(window.localStorage, storageKey) ||
            safeGet(window.sessionStorage, storageKey) ||
            ''
        );
    }

    function appendAttributionParams(url, keys) {
        var targetUrl = new URL(url, window.location.origin);
        var selectedKeys = Array.isArray(keys) && keys.length ? keys : CLICK_ATTR_KEYS;

        for (var i = 0; i < selectedKeys.length; i += 1) {
            var key = selectedKeys[i];
            var value = targetUrl.searchParams.get(key) || getStoredAttributionValue(key);
            if (value) {
                targetUrl.searchParams.set(key, value);
            }
        }

        return targetUrl.toString();
    }

    window.DiffsenseAttribution = {
        ALL_ATTR_KEYS: ALL_ATTR_KEYS,
        CLICK_ATTR_KEYS: CLICK_ATTR_KEYS,
        persistAttributionFromUrl: persistAttributionFromUrl,
        getStoredAttributionValue: getStoredAttributionValue,
        appendAttributionParams: appendAttributionParams
    };

    persistAttributionFromUrl();
})(window);
