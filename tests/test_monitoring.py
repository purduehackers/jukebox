import unittest

import sentry_sdk

from jukebox.monitoring import capture_exception, init_monitoring, monitoring_config


class MonitoringConfigTest(unittest.TestCase):
    def test_disabled_without_dsn(self):
        self.assertIsNone(monitoring_config({}))
        self.assertIsNone(monitoring_config({'JUKEBOX_SENTRY_DSN': '  '}))
        self.assertFalse(init_monitoring({}))
        self.assertFalse(sentry_sdk.is_initialized())
        capture_exception(ValueError('no-op'))  # must not raise

    def test_parses_dsn_and_options(self):
        config = monitoring_config({
            'JUKEBOX_SENTRY_DSN': 'https://key@o123.ingest.us.sentry.io/456',
            'JUKEBOX_SENTRY_ENVIRONMENT': 'venue',
            'JUKEBOX_SENTRY_RELEASE': 'nightly-1',
            'JUKEBOX_SENTRY_TRACES_SAMPLE_RATE': '0.5',
        })
        self.assertEqual(config, {
            'dsn': 'https://key@o123.ingest.us.sentry.io/456',
            'environment': 'venue',
            'release': 'nightly-1',
            'traces_sample_rate': 0.5,
        })

    def test_rate_clamped_and_invalid_defaults_to_zero(self):
        high = monitoring_config({'JUKEBOX_SENTRY_DSN': 'https://k@o/1', 'JUKEBOX_SENTRY_TRACES_SAMPLE_RATE': '5'})
        bad = monitoring_config({'JUKEBOX_SENTRY_DSN': 'https://k@o/1', 'JUKEBOX_SENTRY_TRACES_SAMPLE_RATE': 'nope'})
        self.assertEqual(high['traces_sample_rate'], 1.0)
        self.assertEqual(bad['traces_sample_rate'], 0.0)
        self.assertEqual(bad['environment'], 'development')
        self.assertIsNone(bad['release'])


if __name__ == '__main__':
    unittest.main()
