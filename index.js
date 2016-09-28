'use strict';

/*
This function handles a Slack slash command and echoes the details back to the user.

Follow these steps to configure the slash command in Slack:
  1. Navigate to https://<your-team-domain>.slack.com/services/new
  2. Search for and select "Slash Commands".
  3. Enter a name for your command and click "Add Slash Command Integration".
  4. Copy the token string from the integration settings and use it in the next section.
  5. After you complete this blueprint, enter the provided API endpoint URL in the URL field.

Follow these steps to encrypt your Slack token for use in this function:
  1. Create a KMS key - http://docs.aws.amazon.com/kms/latest/developerguide/create-keys.html.
  2. Encrypt the token using the AWS CLI.
     $ aws kms encrypt --key-id alias/<KMS key name> --plaintext "<COMMAND_TOKEN>"
  3. Copy the base-64 encoded, encrypted key (CiphertextBlob) to the kmsEncyptedToken variable.


Follow these steps to complete the configuration of your command API endpoint

  1. When completing the blueprint configuration select "Open" for security
     on the "Configure triggers" page.
  2. Enter a name for your execution role in the "Role name" field.
     Your function's execution role needs kms:Decrypt permissions. We have
     pre-selected the "KMS decryption permissions" policy template that will
     automatically add these permissions.t
  3. Update the URL for your Slack slash command with the invocation URL for the
     created API resource in the prod stage.
*/

const AWS = require('aws-sdk');
const qs = require('querystring');
var doc = require('dynamodb-doc');
var docClient = new AWS.DynamoDB.DocumentClient();

const usage = 
`Usage:
  /knowledgesharing next
  /knowledgesharing log [@user [yyyy-mm-dd]]
  /knowledgesharing remove @user`;

const kmsEncryptedToken = '<kmsEncryptedToken>';
let token;

function processEvent(event, respondWithBody, callback) {
    
    console.log('Processing event');
    
    // Parse event from Slack
    const slackParams = qs.parse(event.body);
    const requestToken = slackParams.token;
    if (requestToken !== token) {
        console.error(`Request token (${requestToken}) does not match expected`);
        return respondWithBody('Invalid request token');
    }

    const command = slackParams.command;
    const channel = slackParams.channel_name;
    const commandText = slackParams.text;

    console.log('Parsing command line');

    const tokens = commandText.trim().split(/\s+/);
    if (!tokens[0]) {
        respondWithBody(usage);
    }
    // 'remove': Remove user    
    else if (tokens[0] == 'remove') {
        if (tokens.length != 2) {
            respondWithBody(usage);
        }
        console.log('Removing user with docClient.delete');
        docClient.delete({ TableName: "SlackKnowledgeSharing", Key: { "user": tokens[1] } }, function(err, data) {
            if (err) {
                console.log('Error removing user');
                respondWithBody("Unable to delete item. Error JSON:\n" + JSON.stringify(err, null, 2));
            } else {
                console.log('Removed user');
                respondWithBody(null, {
                    "response_type": "in_channel",
                    "text": `Cleared knowledge sharing records for user: ${tokens[1]}`
                });
            }
        });
    }
    // 'next': Trigger another Lambda function to tell Slack who's next up
    else if (tokens[0] == 'next') {
        if (tokens.length != 1) {
            respondWithBody(usage);
        }
        console.log('Triggering KnowledgeSharingNextUp');
        var lambda = new AWS.Lambda();
        
        lambda.invoke({
          FunctionName: 'KnowledgeSharingNextUp',
          Payload: JSON.stringify({ Records: []}, null, 2) // pass params
        }, function(err, data) {
          if (err) {
            console.log('Error triggering KnowledgeSharingNextUp');
            respondWithBody("Unable to call KnowledgeSharingNextUp function; Error JSON:\n" + JSON.stringify(err, null, 2));
          }
          else {
            console.log('Called KnowledgeSharingNextUp');
            callback(null, { statusCode: '200' });
          }
        });
    }
    // Else, make a new knowledge sharing record for the specified (or implied) user
    else if (tokens[0] == 'log') {
        if (tokens.length > 3) {
            respondWithBody(usage);
        }
        var user = tokens[1] ? tokens[1] : '@' + slackParams.user_name;
        var lastDelivered = tokens[2] ? new Date(tokens[2]).getTime() : new Date().getTime();
        console.log('Making new record with docClient.put');
        var params = {
            TableName: "SlackKnowledgeSharing",
            Item:{
                "user": user,
                "lastDelivered": lastDelivered
            }
        };
        
        docClient.put(params, function(err, data) {
            if (err) {
                console.log('Error with docClient.put');
                respondWithBody("Unable to record knowledge sharing. Error JSON:\n" + JSON.stringify(err, null, 2));
            } else {
                console.log('Done with docClient.put');
                respondWithBody(null, {
                    "response_type": "in_channel",
                    "text": `Thanks for sharing your knowledge, <${user}>!` //  has done invoked ${command} in ${channel} with the following text: ${commandText}`
                });
            }
        });
    }
    else {
        respondWithBody(usage);
    }
}


exports.handler = (event, context, callback) => {
    console.log('Handling event');
    const respondWithBody = (err, res) => {
            console.log('Responding with body: ' + JSON.stringify(res));
            callback(null, {
                statusCode: err ? '400' : '200',
                body: err ? (err.message || err) : JSON.stringify(res),
                headers: {
                    'Content-Type': 'application/json',
                },
            });
        };

    if (token) {
        // Container reuse, simply process the event with the key in memory
        processEvent(event, respondWithBody, callback);
    } else if (kmsEncryptedToken && kmsEncryptedToken !== '<kmsEncryptedToken>') {
        const cipherText = { CiphertextBlob: new Buffer(kmsEncryptedToken, 'base64') };
        const kms = new AWS.KMS();
        kms.decrypt(cipherText, (err, data) => {
            if (err) {
                console.log('Decrypt error:', err);
                return respondWithBody(err);
            }
            token = data.Plaintext.toString('ascii');
            processEvent(event, respondWithBody, callback);
        });
    } else {
        respondWithBody('Token has not been set.');
    }
};
