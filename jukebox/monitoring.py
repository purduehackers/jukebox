"""Optional Sentry monitoring for the audio worker.

Everything is keyed off JUKEBOX_SENTRY_DSN (shared with the web authority and
the browser pages): when it is unset or blank, monitoring is fully disabled and
these helpers are no-ops, so fixture runs and tests never send events.
"""
import os


def monitoring_config(env=None):
    env = os.environ if env is None else env
    dsn = (env.get('JUKEBOX_SENTRY_DSN') or '').strip()
    if not dsn:
        return None
    raw_rate = env.get('JUKEBOX_SENTRY_TRACES_SAMPLE_RATE') or env.get('SENTRY_TRACES_SAMPLE_RATE') or ''
    try:
        rate = min(max(float(raw_rate), 0.0), 1.0)
    except ValueError:
        rate = 0.0
    # The container image bakes JUKEBOX_SENTRY_RELEASE from the (possibly empty)
    # SENTRY_RELEASE build arg, so treat blank as unset.
    release = (env.get('JUKEBOX_SENTRY_RELEASE') or env.get('SENTRY_RELEASE') or '').strip()
    return {
        'dsn': dsn,
        'environment': env.get('JUKEBOX_SENTRY_ENVIRONMENT') or env.get('SENTRY_ENVIRONMENT') or 'development',
        'release': release or None,
        'traces_sample_rate': rate,
    }


def init_monitoring(env=None):
    """Initialize sentry-sdk when configured. Returns True when monitoring is active."""
    config = monitoring_config(env)
    if not config:
        return False
    import sentry_sdk
    if sentry_sdk.is_initialized():
        return True
    sentry_sdk.init(
        dsn=config['dsn'],
        environment=config['environment'],
        release=config['release'],
        traces_sample_rate=config['traces_sample_rate'],
        send_default_pii=False,
    )
    return True


def capture_exception(error):
    """Report an error when monitoring is active; safe to call unconditionally."""
    if not error:
        return
    try:
        import sentry_sdk
        if sentry_sdk.is_initialized():
            sentry_sdk.capture_exception(error)
    except Exception:
        pass
