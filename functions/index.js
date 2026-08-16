const { onValueUpdated } = require('firebase-functions/v2/database');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const REGION = 'asia-southeast1';
const DATABASE_INSTANCE = 'jinendravani-main-default-rtdb';

function isTruthy(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function isBlocked(user) {
  if (!user || typeof user !== 'object') return false;
  if (isTruthy(user.blocked) || isTruthy(user.isBlocked)) return true;
  const status = String(user.status || '').trim().toLowerCase();
  return status === 'blocked' || status === 'banned' || status === 'suspended';
}

function getTokens(user) {
  if (!user || typeof user !== 'object') return [];
  const raw = user.fcmTokens ?? user.fcmToken ?? user.messagingToken;
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
  if (raw && typeof raw === 'object') return Object.values(raw).map(String).map(s => s.trim()).filter(Boolean);
  return raw ? [String(raw).trim()].filter(Boolean) : [];
}

exports.notifyUserWhenUnblocked = onValueUpdated(
  {
    ref: '/users/{uid}',
    instance: DATABASE_INSTANCE,
    region: REGION,
    retry: true,
  },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data.before.val();
    const after = event.data.after.val();

    if (!after || typeof after !== 'object') return;
    if (!isBlocked(before) || isBlocked(after)) return;

    const tokens = [...new Set(getTokens(after))];
    if (!tokens.length) {
      logger.warn('User was unblocked but no FCM token is stored.', { uid });
      return;
    }

    const message = {
      tokens,
      notification: {
        title: 'Account Unblocked',
        body: 'Your Jinendra Vani account has been unblocked. You can login now.',
      },
      data: {
        type: 'ACCOUNT_UNBLOCKED',
        action: 'LOGIN_NOW',
        uid,
        title: 'Account Unblocked',
        body: 'Your Jinendra Vani account has been unblocked. You can login now.',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'account_status',
          clickAction: 'JINENDRA_VANI_LOGIN',
          sound: 'default',
        },
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      logger.info('Unblock notification sent.', {
        uid,
        successCount: response.successCount,
        failureCount: response.failureCount,
      });

      const invalidTokens = [];
      response.responses.forEach((result, index) => {
        if (!result.success) {
          const code = result.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
            invalidTokens.push(tokens[index]);
          }
        }
      });

      if (invalidTokens.length) {
        const updates = {};
        const stored = after.fcmTokens;
        if (Array.isArray(stored)) {
          updates[`/users/${uid}/fcmTokens`] = stored.filter(token => !invalidTokens.includes(String(token)));
        } else if (stored && typeof stored === 'object') {
          for (const [key, token] of Object.entries(stored)) {
            if (invalidTokens.includes(String(token))) updates[`/users/${uid}/fcmTokens/${key}`] = null;
          }
        } else if (after.fcmToken && invalidTokens.includes(String(after.fcmToken))) {
          updates[`/users/${uid}/fcmToken`] = null;
        }
        if (Object.keys(updates).length) await admin.database().ref().update(updates);
      }
    } catch (error) {
      logger.error('Failed to send unblock notification.', {
        uid,
        error: error?.message || String(error),
      });
      throw error;
    }
  }
);
