import { db, messaging } from '@/lib/config/database';
import { client } from '@/sanity/lib/client';

/**
 * Dispatches a push notification to a user based on a Sanity Notification Template.
 * 
 * @param uid The generic Firestore user ID to send the notification to.
 * @param eventType The programmatic identifier for the template (e.g. 'order.created')
 * @param variables An object mapping template variables to actual values (e.g. { orderId: '123' })
 */
export async function sendNotificationFromTemplate(uid: string, eventType: string, variables: Record<string, string> = {}) {
  try {
    // 1. Fetch the user's FCM token from Firestore
    const userDoc = await db.collection('customers').doc(uid).get();
    if (!userDoc.exists) {
        console.warn(`Cannot send notification: User ${uid} not found.`);
        return false;
    }
    
    const userData = userDoc.data();
    const fcmToken = userData?.fcmToken;
    if (!fcmToken) {
        console.warn(`Cannot send notification: User ${uid} has no registered fcmToken.`);
        return false;
    }

    // 2. Fetch the corresponding template from Sanity Studio
    const query = `*[_type == "notificationTemplate" && eventType == $eventType][0]`;
    const template = await client.fetch(query, { eventType });

    if (!template) {
        console.error(`Missing notification template for eventType: ${eventType}`);
        return false;
    }

    // 3. Simple Handlebars-style variable replacement
    let title = template.title || 'Notification';
    let body = template.body || '';

    // Replace all instances of {{variableName}} with the value from the variables object
    for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        title = title.replace(regex, value);
        body = body.replace(regex, value);
    }

    // 4. Send via Firebase Admin Messaging SDK
    const message = {
        notification: {
            title,
            body
        },
        token: fcmToken
    };

    const response = await messaging.send(message);
    console.log(`Successfully sent message to ${uid}:`, response);
    return true;
  } catch (error) {
    console.error('Error sending push notification:', error);
    return false;
  }
}
