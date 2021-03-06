/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * Provides access to media protection information and functionality.  Each
 * ProtectionController manages a single {@link MediaPlayer.models.ProtectionModel}
 * which encapsulates a set of protection information (EME APIs, selected key system,
 * key sessions).  The APIs of ProtectionController mostly align with the latest EME
 * APIs.  Key system selection is mostly automated when combined with app-overrideable
 * functionality provided in {@link MediaPlayer.dependencies.ProtectionExtensions}.
 *
 * @class MediaPlayer.dependencies.ProtectionController
 * @todo ProtectionController does almost all of its tasks automatically after init() is
 * called.  Applications might want more control over this process and want to go through
 * each step manually (key system selection, session creation, session maintenance).
 */

// Define ArrayBuffer.isView method in case it is not defined (like in IE11 for example)
if (!ArrayBuffer.isView) {
    ArrayBuffer.isView = function(data) {
        return data instanceof ArrayBuffer;
    };
}

if (!ArrayBuffer.prototype.slice) {
    ArrayBuffer.prototype.slice = function(begin, end) {
        var len = this.byteLength,
            length,
            target,
            targetArray;
        begin = (begin | 0) || 0;
        end = end === (void 0) ? len : (end | 0);

        // Handle negative values.
        if (begin < 0) {
            begin = Math.max(begin + len, 0);
        }
        if (end < 0) {
            end = Math.max(end + len, 0);
        }

        if (len === 0 || begin >= len || begin >= end) {
            return new ArrayBuffer(0);
        }

        length = Math.min(len - begin, end - begin);
        target = new ArrayBuffer(length);
        targetArray = new Uint8Array(target);
        targetArray.set(new Uint8Array(this, begin, length));
        return target;
    };
}

MediaPlayer.dependencies.ProtectionController = function() {
    "use strict";

    var keySystems = null,
        pendingNeedKeyData = [],
        //audioInfo,
        //videoInfo,
        audioCodec,
        videoCodec,
        protDataSet,
        xhrLicense = null,
        initialized = false,

        getProtData = function(keySystem) {
            var protData = null,
                keySystemString = keySystem.systemString;
            if (protDataSet) {
                protData = (keySystemString in protDataSet) ? protDataSet[keySystemString] : null;
            }
            return protData;
        },

        selectKeySystem = function(supportedKS, fromManifest) {

            var self = this,
                sessionType,
                // Build our request object for requestKeySystemAccess
                requestedKeySystems = [],
                keySystemsInfo = [],
                ksIdx,
                ksAccess,
                i = 0,
                ksSelected,
                keySystemAccess;

            self.debug.log("[DRM] Select key system");

            if (this.keySystem) {
                // We have a key system
                for (ksIdx = 0; ksIdx < supportedKS.length; ksIdx++) {
                    if (this.keySystem === supportedKS[ksIdx].ks) {
                        sessionType = supportedKS[ksIdx].ks.sessionType;
                        requestedKeySystems.push({
                            ks: supportedKS[ksIdx].ks,
                            configs: supportedKS[ksIdx].ks.getKeySystemConfigurations(videoCodec, audioCodec, sessionType)
                        });
                        // Key system info in case of error
                        keySystemsInfo.push({
                            schemeIdURI: supportedKS[ksIdx].ks.schemeIdURI,
                            systemString: supportedKS[ksIdx].ks.systemString
                        });

                        // Ensure that we would be granted key system access using the key
                        // system and codec information
                        ksAccess = {};
                        ksAccess[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_ACCESS_COMPLETE] = function(event) {
                            if (event.error) {
                                //if (!fromManifest) {
                                self.eventBus.dispatchEvent({
                                    type: MediaPlayer.dependencies.ProtectionController.events.KEY_SYSTEM_SELECTED,
                                    error: "[DRM] KeySystem Access Denied! -- " + event.error
                                });
                                //}
                            } else {
                                self.debug.log("[DRM] KeySystem Access Granted");
                                self.eventBus.dispatchEvent({
                                    type: MediaPlayer.dependencies.ProtectionController.events.KEY_SYSTEM_SELECTED,
                                    data: event.data
                                });
                                self.createKeySession(supportedKS[ksIdx].initData, supportedKS[ksIdx].cdmData);
                            }
                        };
                        this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_ACCESS_COMPLETE, ksAccess, undefined, true);
                        this.protectionModel.requestKeySystemAccess(requestedKeySystems);
                        break;
                    }
                }
            } else if (this.keySystem === undefined) {
                // First time through, so we need to select a key system
                this.keySystem = null;
                pendingNeedKeyData.push(supportedKS);

                // Add all key systems to our request list since we have yet to select a key system
                for (i = 0; i < supportedKS.length; i++) {
                    sessionType = supportedKS[i].ks.sessionType;
                    requestedKeySystems.push({
                        ks: supportedKS[i].ks,
                        configs: supportedKS[i].ks.getKeySystemConfigurations(videoCodec, audioCodec, sessionType)
                    });
                    // Key system info in case of error
                    keySystemsInfo.push({
                        schemeIdURI: supportedKS[i].ks.schemeIdURI,
                        systemString: supportedKS[i].ks.systemString
                    });
                }

                ksSelected = {};

                ksSelected[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_ACCESS_COMPLETE] = function(event) {
                    if (event.error) {
                        self.debug.log("[DRM] KeySystem Access Denied!");
                        self.keySystem = undefined;
                        self.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_SELECTED, ksSelected);
                        if (!fromManifest) {
                            self.eventBus.dispatchEvent({
                                type: MediaPlayer.dependencies.ProtectionController.events.KEY_SYSTEM_SELECTED,
                                error: "[DRM] KeySystem Access Denied! -- " + event.error
                            });
                        }
                        self.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                            new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYSYSERR_ACCESS_DENIED, "No KeySystem/CDM available", {keySystems: keySystemsInfo}));
                    } else {
                        keySystemAccess = event.data;
                        self.debug.log("[DRM] KeySystem Access (" + keySystemAccess.keySystem.systemString + ") Granted!  Selecting key system...");
                        self.protectionModel.selectKeySystem(keySystemAccess);
                    }
                };
                ksSelected[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_SELECTED] = function(event) {
                    if (!event.error) {
                        self.debug.log("[DRM] KeySystem selected => create key session");
                        self.keySystem = self.protectionModel.keySystem;
                        self.eventBus.dispatchEvent({
                            type: MediaPlayer.dependencies.ProtectionController.events.KEY_SYSTEM_SELECTED,
                            data: keySystemAccess
                        });
                        for (i = 0; i < pendingNeedKeyData.length; i++) {
                            for (ksIdx = 0; ksIdx < pendingNeedKeyData[i].length; ksIdx++) {
                                if (self.keySystem === pendingNeedKeyData[i][ksIdx].ks) {
                                    self.createKeySession(pendingNeedKeyData[i][ksIdx].initData, pendingNeedKeyData[i][ksIdx].cdmData);
                                    break;
                                }
                            }
                        }
                    } else {
                        self.keySystem = undefined;
                        if (!fromManifest) {
                            self.eventBus.dispatchEvent({
                                type: MediaPlayer.dependencies.ProtectionController.events.KEY_SYSTEM_SELECTED,
                                error: "[DRM] Error selecting key system! -- " + event.error
                            });
                        }
                        self.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                            new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYSYSERR_ACCESS_DENIED, "No KeySystem/CDM available", {keySystems: keySystemsInfo}));

                    }
                };
                this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_SELECTED, ksSelected, undefined, true);
                this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SYSTEM_ACCESS_COMPLETE, ksSelected, undefined, true);

                this.protectionModel.requestKeySystemAccess(requestedKeySystems);
            } else {
                // We are in the process of selecting a key system, so just save the data
                pendingNeedKeyData.push(supportedKS);
            }
        },

        /*sendLicenseRequestCompleteEvent = function(data) {
            this.eventBus.dispatchEvent({
                type: MediaPlayer.dependencies.ProtectionController.events.LICENSE_REQUEST_COMPLETE,
                data: data
            });
        },*/

        onKeyMessage = function(e) {
            var self = this,
                licenseMessage = null,
                keyMessage,
                messageType;

            keyMessage = e.data;
            messageType = (keyMessage.messageType) ? keyMessage.messageType : "license-request";
            this.debug.log("[DRM] Key message: type = " + messageType);

            // Dispatch event to applications indicating we received a key message
            this.eventBus.dispatchEvent({
                type: MediaPlayer.dependencies.ProtectionController.events.KEY_MESSAGE,
                data: keyMessage
            });

            var message = keyMessage.message,
                sessionToken = keyMessage.sessionToken,
                protData = getProtData(this.keySystem),
                keySystemString = this.keySystem.systemString,
                licenseServerData = this.protectionExt.getLicenseServer(this.keySystem, protData, messageType),
                needFailureReport = true/*,
                eventData = {
                    sessionToken: sessionToken,
                    messageType: messageType
                }*/;

            // Ensure message from CDM is not empty
            if (!message || message.byteLength === 0) {
                this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                    new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYMESSERR_NO_CHALLENGE, "Empty key message from CDM"));
                return;
            }

            // Message not destined for license server
            if (!licenseServerData) {
                this.debug.log("[DRM] License server request not required for this message (type = " + e.data.messageType + ").  Session ID = " + sessionToken.getSessionID());
                return;
            }

            // Perform any special handling for ClearKey
            if (this.protectionExt.isClearKey(this.keySystem)) {
                var clearkeys = this.protectionExt.processClearKeyLicenseRequest(protData, message);
                if (clearkeys) {
                    this.debug.log("[DRM] ClearKey license request handled by application!");
                    this.protectionModel.updateKeySession(sessionToken, clearkeys);
                    return;
                }
            }

            // All remaining key system scenarios require a request to a remote license server
            xhrLicense = new XMLHttpRequest();

            // Determine license server URL
            var url = null;
            if (protData) {
                if (protData.serverURL) {
                    var serverURL = protData.serverURL;
                    if (typeof serverURL === "string" && serverURL !== "") {
                        url = serverURL;
                    } else if (typeof serverURL === "object" && serverURL.hasOwnProperty(messageType)) {
                        url = serverURL[messageType];
                    }
                } else if (protData.laURL && protData.laURL !== "") { // TODO: Deprecated!
                    url = protData.laURL;
                }
            }

            if (url === null) {
                url = this.keySystem.getLicenseServerURLFromInitData(MediaPlayer.dependencies.protection.CommonEncryption.getPSSHData(sessionToken.initData));
                if (!url) {
                    url = e.data.defaultURL;
                }
            }
            // Possibly update or override the URL based on the message
            url = licenseServerData.getServerURLFromMessage(url, message, messageType);

            this.debug.log("[DRM] Licenser server url: " + url);

            // Ensure valid license server URL
            if (!url) {
                this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                    new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYMESSERR_URL_LICENSER_UNKNOWN, "No license server URL specified"));
                return;
            }

            xhrLicense.open(licenseServerData.getHTTPMethod(messageType), url, true);
            xhrLicense.responseType = licenseServerData.getResponseType(keySystemString, messageType);
            xhrLicense.onload = function() {

                if (this.status < 200 || this.status > 299) {
                    return;
                }

                if (this.status === 200 && this.readyState === 4) {
                    self.debug.log("[DRM] Received license response");
                    needFailureReport = false;
                    licenseMessage = licenseServerData.getLicenseMessage(this.response, keySystemString, messageType);
                    if (licenseMessage !== null) {
                        needFailureReport = false;
                        self.protectionModel.updateKeySession(sessionToken, licenseMessage);
                    } else {
                        needFailureReport = true;
                    }
                }
            };

            xhrLicense.onerror = xhrLicense.onloadend = function() {
                if (!needFailureReport) {
                    xhrLicense = null;
                    return;
                }
                needFailureReport = false;

                // send error only if request has  not been aborted by reset
                if (!this.aborted) {
                    self.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                        new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYMESSERR_LICENSER_ERROR, "License request failed", {
                            url: url,
                            status: this.status,
                            error: (this.response && this.response !== null) ? licenseServerData.getErrorResponse(this.response) : ""
                        }));
                }
                xhrLicense = null;
            };

            // Set optional XMLHttpRequest headers from protection data and message
            var updateHeaders = function(headers) {
                var key;
                if (headers) {
                    for (key in headers) {
                        if ('authorization' === key.toLowerCase()) {
                            xhrLicense.withCredentials = true;
                        }
                        xhrLicense.setRequestHeader(key, headers[key]);
                    }
                }
            };
            if (protData) {
                updateHeaders(protData.httpRequestHeaders);
            }
            updateHeaders(this.keySystem.getRequestHeadersFromMessage(message));

            // Set withCredentials property from protData
            if (protData && protData.withCredentials) {
                xhrLicense.withCredentials = true;
            }

            this.debug.log("[DRM] Send license request");
            var licenseRequest = this.keySystem.getLicenseRequestFromMessage(message);
            if (licenseRequest === null) {
                this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                    new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYMESSERR_NO_CHALLENGE, "No license challenge from CDM key message"));
            }
            xhrLicense.send(licenseRequest);
        },

        onNeedKey = function(event) {

            var self = this,
                abInitData,
                supportedKS;

            self.debug.log("[DRM] onNeedKey, initDataType = " + event.data.initDataType);

            // Ignore non-cenc initData
            if (event.data.initDataType !== "cenc") {
                self.debug.log("[DRM] Only 'cenc' initData is supported!  Ignoring initData of type: " + event.data.initDataType);
                return;
            }

            // Some browsers return initData as Uint8Array (IE), some as ArrayBuffer (Chrome).
            // Convert to ArrayBuffer
            abInitData = event.data.initData;
            if (ArrayBuffer.isView(abInitData)) {
                abInitData = abInitData.buffer;
            }

            supportedKS = this.protectionExt.getSupportedKeySystems(abInitData);
            if (supportedKS.length === 0) {
                self.debug.log("[DRM] Received needkey event with initData, but we don't support any of the key systems!");
                return;
            }

            selectKeySystem.call(this, supportedKS, false);
        },

        onServerCertificateUpdated = function(event) {
            if (!event.error) {
                this.debug.log("[DRM] License server certificate successfully updated");
            } else {
                this.debug.error("[DRM] Failed to set license server certificate");
                this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                    new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYERR_SERVER_CERTIFICATE, "Failed to set server certificate", event.error));
            }
        },

        onKeySessionCreated = function(event) {
            if (!event.error) {
                this.debug.log("[DRM] Session created.  SessionID = " + event.data.getSessionID());
            } else {
                this.debug.error("[DRM] Failed to create key session");
                this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                    new MediaPlayer.vo.Error(MediaPlayer.dependencies.ErrorHandler.prototype.MEDIA_KEYMESSERR_NO_SESSION, "Failed to create key session", event.error));
            }
        },

        onKeyAdded = function( /*event*/ ) {
            this.debug.log("[DRM] Key added");
        },

        onKeyError = function(event) {
            this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                new MediaPlayer.vo.Error(event.data.code, event.data.message, event.data.data));
        },

        onKeySessionClosed = function(event) {
            if (!event.error) {
                this.debug.log("[DRM] Session closed.  SessionID = " + event.data);
            } else {
                this.debug.warn("[DRM] Failed to close session");
            }
        },

        onKeySessionRemoved = function(event) {
            if (!event.error) {
                this.debug.log("[DRM] Session removed.  SessionID = " + event.data);
            } else {
                this.debug.warn("[DRM] Failed to remove session");
            }
        },

        onKeyStatusesChanged = function(event) {
            if (!event.error) {
                this.debug.log("[DRM] Key statuses changed. statuses = " + event.data);
            } else {
                this.notify(MediaPlayer.dependencies.ProtectionController.eventList.ENAME_PROTECTION_ERROR,
                    new MediaPlayer.vo.Error(event.error.code, event.error.message, event.error.data));
            }
        };

    return {
        system: undefined,
        debug: undefined,
        notify: undefined,
        subscribe: undefined,
        unsubscribe: undefined,
        protectionExt: undefined,
        keySystem: undefined,

        setup: function() {
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_MESSAGE] = onKeyMessage.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_NEED_KEY] = onNeedKey.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_SERVER_CERTIFICATE_UPDATED] = onServerCertificateUpdated.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_ADDED] = onKeyAdded.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_ERROR] = onKeyError.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CREATED] = onKeySessionCreated.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CLOSED] = onKeySessionClosed.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_REMOVED] = onKeySessionRemoved.bind(this);
            this[MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_STATUSES_CHANGED] = onKeyStatusesChanged.bind(this);

            keySystems = this.protectionExt.getKeySystems();
            this.protectionModel = this.system.getObject("protectionModel");
            this.protectionModel.init();

            this.eventBus = this.system.getObject("eventBus");

            // Subscribe to events
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_SERVER_CERTIFICATE_UPDATED, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_ADDED, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_ERROR, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CREATED, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CLOSED, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_REMOVED, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_MESSAGE, this);
            this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_STATUSES_CHANGED, this);
        },

        /**
         * Initialize this protection system with a given manifest and optional audio
         * and video stream information.
         *
         * @param {Object} manifest the json version of the manifest XML document for the
         * desired content.  Applications can download their manifest using
         * {@link MediaPlayer#retrieveManifest}
         * @param {MediaPlayer.vo.StreamInfo} [aInfo] audio stream information
         * @param {MediaPlayer.vo.StreamInfo} [vInfo] video stream information
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         * @todo This API will change when we have better support for allowing applications
         * to select different adaptation sets for playback.  Right now it is clunky for
         * applications to create {@link MediaPlayer.vo.StreamInfo} with the right information,
         */
        init: function(contentProtection, aCodec, vCodec) {
            var supportedKS;
            // TODO: We really need to do much more here... We need to be smarter about knowing
            // which adaptation sets for which we have initialized, including the default key ID
            // value from the ContentProtection elements so we know whether or not we still need to
            // select key systems and acquire keys.
            if (!initialized) {

                this.debug.log("[DRM] Initialize ProtectionController (" + vCodec + ", " + aCodec + ")");

                audioCodec = aCodec;
                videoCodec = vCodec;

                // ContentProtection elements are specified at the AdaptationSet level, so the CP for audio
                // and video will be the same.  Just use one valid MediaInfo object
                supportedKS = this.protectionExt.getSupportedKeySystemsFromContentProtection(contentProtection);
                if (supportedKS && supportedKS.length > 0) {
                    selectKeySystem.call(this, supportedKS, true);
                }

                initialized = true;
            }
        },

        /**
         * ProtectionController Event Listener
         *
         * @callback MediaPlayer.dependencies.ProtectionController~eventListener
         * @param {Object} event The event.  See the documentation for ProtectionController
         * APIs to see what events are fired by each API call
         */

        /**
         * Add a listener for ProtectionController events
         *
         * @param type the event ID
         * @param {MediaPlayer.dependencies.ProtectionController~eventListener} listener
         * the event listener to add
         * @see MediaPlayer.dependencies.ProtectionController.events
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         */
        addEventListener: function(type, listener) {
            this.eventBus.addEventListener(type, listener);
        },

        /**
         * Remove a listener for ProtectionController events
         *
         * @param type the event ID associated with the listener to rmove
         * @param {MediaPlayer.dependencies.ProtectionController~eventListener} listener
         * the event listener to remove
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         */
        removeEventListener: function(type, listener) {
            this.eventBus.removeEventListener(type, listener);
        },

        /**
         * Destroys all protection data associated with this protection set.  This includes
         * deleting all key sessions.  In the case of persistent key sessions, the sessions
         * will simply be unloaded and not deleted.  Additionally, if this protection set is
         * associated with a HTMLMediaElement, it will be detached from that element.
         *
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         */
        teardown: function() {
            // abort request if xhrLicense is different from null
            if (xhrLicense) {
                xhrLicense.aborted = true;
                xhrLicense.abort();
            }
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_MESSAGE, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_SERVER_CERTIFICATE_UPDATED, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_ADDED, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_ERROR, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CREATED, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CLOSED, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_REMOVED, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_MESSAGE, this);
            this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_STATUSES_CHANGED, this);
            this.keySystem = undefined;

            this.protectionModel.teardown();
            this.setMediaElement(null);
            this.protectionModel = undefined;
        },

        /**
         * Create a new key session associated with the given initialization data from
         * the MPD or from the PSSH box in the media
         *
         * @param {ArrayBuffer} initData the initialization data
         * @param {Uint8Array} cdmData the custom data to provide to licenser
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         * @fires MediaPlayer.dependencies.ProtectionController#KeySessionCreated
         * @todo In older versions of the EME spec, there was a one-to-one relationship between
         * initialization data and key sessions.  That is no longer true in the latest APIs.  This
         * API will need to modified (and a new "generateRequest(keySession, initData)" API created)
         * to come up to speed with the latest EME standard
         */
        createKeySession: function(initData, cdmData) {

            this.debug.log("[DRM] Create key session");

            var initDataForKS = MediaPlayer.dependencies.protection.CommonEncryption.getPSSHForKeySystem(this.keySystem, initData),
                i = 0,
                currentInitData;
            if (initDataForKS) {
                // Check for duplicate initData
                currentInitData = this.protectionModel.getAllInitData();
                for (i = 0; i < currentInitData.length; i++) {
                    if (this.protectionExt.initDataEquals(initDataForKS, currentInitData[i])) {
                        this.debug.log("[DRM] Ignoring initData because we have already seen it!");
                        // If Key session already exists for this content, we check if the session and stored license key
                        // correclty decrypt the content
                        //this.protectionModel.checkIfEncrypted();
                        return;
                    }
                }
                try {
                    this.protectionModel.createKeySession(initDataForKS, this.keySystem.sessionType, cdmData);
                } catch (ex) {
                    this.notify(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CREATED, null, {
                        reason: "Create key session raised en exception",
                        error: new MediaPlayer.vo.Error(ex.code, ex.name, ex.message)
                    });
                }
            } else {
                this.notify(MediaPlayer.models.ProtectionModel.eventList.ENAME_KEY_SESSION_CREATED, null, {
                    reason: "needkey/encrypted event contains no initData corresponding to that key system " + this.keySystem.systemString,
                    error: null
                });
            }
        },

        /**
         * Loads a key session with the given session ID from persistent storage.  This
         * essentially creates a new key session
         *
         * @param {string} sessionID
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         * @fires MediaPlayer.dependencies.ProtectionController#KeySessionCreated
         */
        loadKeySession: function(sessionID) {
            this.protectionModel.loadKeySession(sessionID);
        },

        /**
         * Removes the given key session from persistent storage and closes the session
         * as if {@link MediaPlayer.dependencies.ProtectionController#closeKeySession}
         * was called
         *
         * @param {MediaPlayer.vo.protection.SessionToken} sessionToken the session
         * token
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         * @fires MediaPlayer.dependencies.ProtectionController#KeySessionRemoved
         * @fires MediaPlayer.dependencies.ProtectionController#KeySessionClosed
         */
        removeKeySession: function(sessionToken) {
            this.protectionModel.removeKeySession(sessionToken);
        },

        /**
         * Closes the key session and releases all associated decryption keys.  These
         * keys will no longer be available for decrypting media
         *
         * @param {MediaPlayer.vo.protection.SessionToken} sessionToken the session
         * token
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         * @fires MediaPlayer.dependencies.ProtectionController#KeySessionClosed
         */
        closeKeySession: function(sessionToken) {
            this.protectionModel.closeKeySession(sessionToken);
        },

        /**
         * Sets a server certificate for use by the CDM when signing key messages
         * intended for a particular license server.  This will fire
         * an error event if a key system has not yet been selected.
         *
         * @param {ArrayBuffer} serverCertificate a CDM-specific license server
         * certificate
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         * @fires MediaPlayer.dependencies.ProtectionController#ServerCertificateUpdated
         */
        setServerCertificate: function(serverCertificate) {
            this.protectionModel.setServerCertificate(serverCertificate);
        },

        /**
         * Associate this protection system with the given HTMLMediaElement.  This
         * causes the system to register for needkey/encrypted events from the given
         * element and provides a destination for setting of MediaKeys
         *
         * @param {HTMLMediaElement} element the media element to which the protection
         * system should be associated
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         */
        setMediaElement: function(element) {
            if (element) {
                this.protectionModel.setMediaElement(element);
                this.protectionModel.subscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_NEED_KEY, this);
            } else if (element === null) {
                this.protectionModel.setMediaElement(element);
                this.protectionModel.unsubscribe(MediaPlayer.models.ProtectionModel.eventList.ENAME_NEED_KEY, this);
            }
        },

        /**
         * Sets the session type to use when creating key sessions.  Either "temporary" or
         * "persistent-license".  Default is "temporary".
         *
         * @param {String} sessionType the session type
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         */
        setSessionType: function(sessionType) {
            if (this.keysystem) {
                this.keySystem.sessionType = sessionType;
            }
        },

        /**
         * Attach KeySystem-specific data to use for license acquisition with EME
         *
         * @param {Object} data an object containing property names corresponding to
         * key system name strings (e.g. "org.w3.clearkey") and associated values
         * being instances of {@link MediaPlayer.vo.protection.ProtectionData}
         * @memberof MediaPlayer.dependencies.ProtectionController
         * @instance
         */
        setProtectionData: function(data) {
            protDataSet = data;
            this.protectionExt.init(data);
        }
    };
};

/**
 * Key system selection event
 *
 * @event MediaPlayer.dependencies.ProtectionController#KeySystemSelected
 * @type {Object}
 * @property {MediaPlayer.vo.protection.KeySystemAccess} data key system
 * access object that describes the selected key system and associated
 * audio/video codecs and CDM capabilities.  May be null if an error occurred
 * @property {string} error if not null, an error occurred and this object
 * will contain an informative error string describing the failure
 */

/**
 * Key session creation event
 *
 * @event MediaPlayer.dependencies.ProtectionController#KeySessionCreated
 * @type {Object}
 * @property {MediaPlayer.vo.protection.SessionToken} data the session token
 * that can be used to access certain properties of the session.  Also
 * required for other ProtectionController APIs that act on key sessions.
 * @property {string} error if not null, an error occurred and this object
 * will contain an informative error string describing the failure
 */

/**
 * Key session removed event
 *
 * @event MediaPlayer.dependencies.ProtectionController#KeySessionRemoved
 * @type {Object}
 * @property {string} data the session ID of the session that was removed
 * from persistent storage
 * @property {string} error if not null, an error occurred and this object
 * will contain an informative error string describing the failure
 */

/**
 * Key session closed event
 *
 * @event MediaPlayer.dependencies.ProtectionController#KeySessionClosed
 * @type {Object}
 * @property {string} data the session ID of the session that was closed
 * @property {string} error if not null, an error occurred and this object
 * will contain an informative error string describing the failure
 */

/**
 * Server certificate updated event
 *
 * @event MediaPlayer.dependencies.ProtectionController#ServerCertificateUpdated
 * @type {Object}
 * @property {Object} data unused for this event.  The server certificate update
 * was is successful if the "error" property of this event is null or undefined
 * @property {string} error if not null, an error occurred and this object
 * will contain an informative error string describing the failure
 */

/**
 * License request completed event
 *
 * @event MediaPlayer.dependencies.ProtectionController#LicenseRequestComplete
 * @type {Object}
 * @property {Object} data The event data.  This data will be provided regardless
 * of the success/failure status of the event
 * @property {MediaPlayer.vo.protection.SessionToken} data.sessionToken session token
 * associated with this license response.  Will never be null, even in error cases.
 * @property {String} data.messageType the message type associated with this request.
 * Supported message types can be found
 * {@link https://w3c.github.io/encrypted-media/#idl-def-MediaKeyMessageType|here}.
 * @property {string} error if not null, an error occurred and this object
 * will contain an informative error string describing the failure
 */

/**
 * Events names for events sent by ProtectionController.  Use these event
 * names when subscribing or unsubscribing from ProtectionController events
 *
 * @enum {String}
 * @see MediaPlayer.dependencies.ProtectionController#addEventListener
 */
MediaPlayer.dependencies.ProtectionController.events = {
    /**
     * Event ID for events delivered when a key system selection procedure
     * has completed
     *
     * @constant
     */
    KEY_SYSTEM_SELECTED: "keySystemSelected",
    /**
     * Event ID for events delivered when the protection set receives
     * a key message from the CDM
     *
     * @constant
     */
    SERVER_CERTIFICATE_UPDATED: "serverCertificateUpdated",
    /**
     * Event ID for events delivered when a new key has been added
     *
     * @constant
     * @deprecated The latest versions of the EME specification no longer
     * use this event. {@MediaPlayer.dependencies.ProtectionController.events.KEY_STATUSES_CHANGED}
     * is preferred.
     */
    KEY_ADDED: "keyAdded",
    /**
     * Event ID for events delivered when a new key sessions creation
     * process has completed
     *
     * @constant
     */
    KEY_SESSION_CREATED: "keySessionCreated",
    /**
     * Event ID for events delivered when a key session removal
     * process has completed
     *
     * @constant
     */
    KEY_SESSION_REMOVED: "keySessionRemoved",
    /**
     * Event ID for events delivered when a key session close
     * process has completed
     *
     * @constant
     */
    KEY_SESSION_CLOSED: "keySessionClosed",
    /**
     * Event ID for events delivered when the status of one or more
     * decryption keys has changed
     *
     * @constant
     */
    KEY_STATUSES_CHANGED: "keyStatusesChanged",
    /**
     * Event ID for events delivered when the protection system receives
     * a key message from the CDM
     *
     * @constant
     */
    KEY_MESSAGE: "keyMessage",
    /**
     * Event ID for events delivered when a license request procedure
     * has completed
     *
     * @constant
     */
    LICENSE_REQUEST_COMPLETE: "licenseRequestComplete"
};

MediaPlayer.dependencies.ProtectionController.eventList = {
    ENAME_PROTECTION_ERROR: "protectionError"
};

MediaPlayer.dependencies.ProtectionController.prototype = {
    constructor: MediaPlayer.dependencies.ProtectionController
};
