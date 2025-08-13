class RoadTestRecorder {
    static STATES = {
        STOPPED: 'stopped',
        STARTING: 'starting',
        RECORDING: 'recording',
        PAUSING: 'pausing'
    };

    constructor() {
        this.state = RoadTestRecorder.STATES.STOPPED;
        this.isRecording = false;
        this.testData = [];
        this.testSessions = []; // 测试会话历史
        this.currentSession = null;
        this.timerInterval = null;
        this.startTime = null;
        this.displayTimer = null;
        this.debugTimer = null;
        this.lastRecentData = null;
        this.urlObjectsToCleanup = new Set();
        
        // 阿里云实时语音识别API配置
        this.aliyunConfig = {
            accessKeyId: '', // 待填入
            accessKeySecret: '', // 待填入
            appKey: '', // 待填入
            // WebSocket实时识别URL
            wsUrl: '', // 待填入具体地址
            // 音频参数 (阿里云支持多种格式)
            sampleRate: 16000,
            encoding: 'PCM', // PCM/WAV/OGG/MP3/AAC
            channels: 1,
            // 识别参数
            language: 'zh-CN',
            enablePunctuation: true, // 启用标点符号
            enableIntermediateResult: true, // 中间结果
            enableInverseTextNormalization: true // 数字转换
        };
        
        // WebSocket连接相关
        this.websocket = null;
        this.wsReconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.connectionRetryDelay = 5000; // 5秒重试延迟
        
        // 录音相关
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecordingAudio = false;
        
        // 初始化录音功能（暂不立即连接WebSocket）
        this.initAudioRecording();
        
        // 绑定事件
        this.bindEvents();
        
        // 加载数据
        this.loadData();
        this.loadSessionData();
        this.loadApiKey();
        
        // 更新UI
        this.updateUI();
        
        
        // 测试签名算法
        this.testSignatureAlgorithm();
        
        // 测试字幕显示功能
        this.testSubtitleDisplay();
    }
    
    // 重置录制状态的紧急方法
    resetState() {
        console.log('🔄 重置录制状态');
        this.state = RoadTestRecorder.STATES.STOPPED;
        this.isRecording = false;
        this.isRecordingAudio = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        this.updateUI();
        this.showDebugInfo('✅ 状态已重置');
        console.log('✅ 状态重置完成');
    }

    async testBaiduAPIConnection() {
        console.log('🔍 开始百度API连接测试...');
        console.log('📋 API配置检查:', {
            appId: this.baiduConfig.appId,
            hasApiKey: !!this.baiduConfig.apiKey,
            hasSecretKey: !!this.baiduConfig.secretKey,
            apiKeyLength: this.baiduConfig.apiKey ? this.baiduConfig.apiKey.length : 0,
            secretKeyLength: this.baiduConfig.secretKey ? this.baiduConfig.secretKey.length : 0,
            tokenUrl: this.baiduConfig.tokenUrl,
            asrUrl: this.baiduConfig.asrUrl
        });
        
        if (!this.baiduConfig.apiKey || !this.baiduConfig.secretKey) {
            console.error('❌ 百度API配置不完整');
            this.showDebugInfo('❌ 百度API配置不完整');
            return false;
        }

        // 测试网络连接
        console.log('🌐 测试网络连接...');
        try {
            const networkTest = await fetch('https://www.baidu.com', { 
                method: 'HEAD',
                mode: 'no-cors'  // 避免CORS问题
            });
            console.log('✅ 网络连接正常');
        } catch (error) {
            console.error('❌ 网络连接失败:', error.message);
            this.showDebugInfo('❌ 网络连接失败');
            return false;
        }

        // 测试Token获取
        console.log('🔑 测试Token获取...');
        try {
            const startTime = performance.now();
            const token = await this.getBaiduAccessToken();
            const endTime = performance.now();
            
            if (token) {
                console.log('✅ Token获取成功:', {
                    token长度: token.length,
                    耗时: Math.round(endTime - startTime) + 'ms',
                    token前缀: token.substring(0, 20) + '...'
                });
                this.showDebugInfo('✅ 百度API连接正常');
                return true;
            } else {
                console.error('❌ Token为空');
                this.showDebugInfo('❌ 无法获取access_token');
                return false;
            }
        } catch (error) {
            console.error('❌ API连接测试失败:', {
                错误类型: error.name,
                错误信息: error.message,
                错误堆栈: error.stack
            });
            
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                this.showDebugInfo('❌ 网络请求被阻止，可能是CORS问题');
            } else {
                this.showDebugInfo(`❌ API连接失败: ${error.message}`);
            }
            return false;
        }
    }

    async initAudioRecording() {
        try {
            // 清理旧的音频流和上下文
            if (this.audioStream) {
                this.audioStream.getTracks().forEach(track => track.stop());
            }
            if (this.audioContext) {
                await this.audioContext.close();
            }
            
            // 录音参数，优化为阿里云API要求的格式
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    sampleRate: 16000,     // 阿里云要求16kHz
                    channelCount: 1,       // 单声道
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false // 关闭自动增益，保持音频质量
                }
            });
            
            this.audioStream = stream;
            
            // 创建音频上下文用于直接获取PCM数据
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
            
            this.audioSource = this.audioContext.createMediaStreamSource(stream);
            
            // 使用ScriptProcessor直接获取PCM数据
            this.scriptProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
            
            this.scriptProcessor.onaudioprocess = (event) => {
                if (this.isRecordingAudio && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                    const inputBuffer = event.inputBuffer.getChannelData(0);
                    this.sendPCMDataDirectly(inputBuffer);
                }
            };
            
            // 连接音频节点
            this.audioSource.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);
            console.log('🎤 音频流初始化成功:', {
                活跃状态: stream.active,
                音频轨道数: stream.getAudioTracks().length,
                轨道状态: stream.getAudioTracks().map(track => ({
                    enabled: track.enabled,
                    muted: track.muted,
                    readyState: track.readyState
                }))
            });
            this.showDebugInfo('🎤 录音设备初始化成功');
        } catch (error) {
            console.error('录音设备初始化失败:', error);
            this.showDebugInfo('❌ 录音设备初始化失败');
        }
    }

    async startAudioRecording() {
        if (!this.audioStream) {
            this.showDebugInfo('❌ 录音设备未初始化');
            return;
        }

        // 检查音频流是否仍然有效
        if (!this.audioStream.active || this.audioStream.getTracks().length === 0) {
            console.warn('⚠️ 音频流已失效，重新初始化');
            await this.initAudioRecording();
            return this.startAudioRecording();
        }

        console.log('🚀 开始音频录制，使用阿里云API (PCM直传)');
        
        try {
            // 使用ScriptProcessor直接获取PCM数据
            if (!this.audioContext) {
                this.audioContext = new AudioContext({ sampleRate: 16000 });
            }
            
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            const source = this.audioContext.createMediaStreamSource(this.audioStream);
            this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
            
            this.scriptProcessor.onaudioprocess = (e) => {
                if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.isRecordingAudio) {
                    const inputData = e.inputBuffer.getChannelData(0);
                    const pcm16 = new Int16Array(inputData.length);
                    
                    // 转PCM 16bit
                    for (let i = 0; i < inputData.length; i++) {
                        const s = Math.max(-1, Math.min(1, inputData[i]));
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    
                    // 直接发送PCM数据
                    this.websocket.send(pcm16.buffer);
                    console.log('📡 发送PCM数据:', pcm16.length, 'samples');
                }
            };
            
            source.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);
            
            this.isRecordingAudio = true;
            console.log('✅ PCM实时录音已启动');
            this.showDebugInfo('🎤 PCM实时录音中');
            
        } catch (error) {
            console.error('❌ 启动PCM录音失败:', error);
            this.showDebugInfo('❌ PCM录音启动失败');
        }
        
        // 如果已有MediaRecorder，先清理
        if (this.mediaRecorder) {
            try {
                if (this.mediaRecorder.state !== 'inactive') {
                    this.mediaRecorder.stop();
                }
            } catch (e) {
                console.warn('清理旧MediaRecorder时出错:', e);
            }
        }
        
        // WebSocket实时识别：强制使用WAV格式
        let options = {};
        const supportedTypes = [
            'audio/wav',                  // WebSocket API首选
            'audio/wav; codecs=1',        // PCM wav
            'audio/webm',                 // 备用选择（需要转换）
            'audio/webm;codecs=opus'
        ];
        
        console.log('🔍 浏览器音频格式支持检查:', supportedTypes.map(type => ({
            格式: type,
            支持: MediaRecorder.isTypeSupported(type) ? '✅' : '❌'
        })));
        
        for (const type of supportedTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                options = { mimeType: type };
                console.log('✅ 选择音频格式:', type);
                break;
            }
        }
        
        // 如果没有找到支持的格式，使用默认
        if (!options.mimeType) {
            console.warn('⚠️ 没有找到理想格式，使用浏览器默认格式');
        }
        
        // 如果不是WAV格式，添加警告
        if (!options.mimeType || !options.mimeType.includes('wav')) {
            console.warn('⚠️ 当前格式可能与WebSocket API不兼容:', options.mimeType);
            this.showDebugInfo('⚠️ 音频格式可能需要优化');
        }
        
        console.log('🎵 音频格式选择:', {
            使用格式: options.mimeType || '默认',
            支持格式: supportedTypes.filter(type => MediaRecorder.isTypeSupported(type))
        });
        
        // 创建新的MediaRecorder实例
        this.mediaRecorder = new MediaRecorder(this.audioStream, options);

        this.mediaRecorder.ondataavailable = (event) => {
            console.log('📼 ondataavailable触发:', {
                数据大小: event.data.size,
                数据类型: event.data.type,
                时间戳: new Date().toLocaleTimeString(),
                录音器状态: this.mediaRecorder.state
            });
            
            if (event.data.size > 0) {
                console.log('📼 收到有效音频数据:', event.data.size, 'bytes');
                // 实时发送音频数据到WebSocket
                this.sendAudioDataToWebSocket(event.data);
            } else {
                console.warn('⚠️ 收到空音频数据');
            }
        };

        this.mediaRecorder.onstart = () => {
            console.log('🎤 MediaRecorder已启动:', {
                状态: this.mediaRecorder.state,
                流状态: this.audioStream ? '活跃' : '未获取',
                轨道数量: this.audioStream ? this.audioStream.getTracks().length : 0,
                音频轨道: this.audioStream ? this.audioStream.getAudioTracks().map(track => ({
                    enabled: track.enabled,
                    muted: track.muted,
                    readyState: track.readyState
                })) : []
            });
        };

        this.mediaRecorder.onerror = (event) => {
            console.error('❌ MediaRecorder错误:', event.error);
        };

        this.mediaRecorder.onstop = () => {
            const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
            const audioBlob = new Blob(this.audioChunks, { type: mimeType });
            console.log('⏹️ 录音停止详情:', {
                音频大小: audioBlob.size + ' bytes',
                类型: mimeType,
                数据块数量: this.audioChunks.length,
                各块大小: this.audioChunks.map(chunk => chunk.size)
            });
            
            // 检查音频数据是否有效
            if (audioBlob.size === 0) {
                console.warn('⚠️ 录音数据为空，跳过处理');
                return;
            }
            
            // 使用百度API处理音频
            this.processAudioWithBaidu(audioBlob);
        };

        // 禁用MediaRecorder，已由ScriptProcessor处理
        // this.mediaRecorder.start(200); 
        // this.isRecordingAudio = true; // 已在ScriptProcessor中设置
        console.log('✅ 使用ScriptProcessor进行PCM录音');
    }

    stopAudioRecording() {
        this.isRecordingAudio = false;
        
        if (this.audioProcessInterval) {
            clearInterval(this.audioProcessInterval);
            this.audioProcessInterval = null;
        }

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
        }
        
        // 发送结束帧到WebSocket
        this.sendFinishFrame();
        
        this.showDebugInfo('⏹️ 实时录音已停止');
    }

    sendFinishFrame() {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.isTranscriptionStarted) {
            // 阿里云API规范的结束消息
            const stopMessage = {
                header: {
                    message_id: this.generateMessageId(),
                    task_id: this.currentTaskId,
                    namespace: 'SpeechTranscriber',
                    name: 'StopTranscription',
                    appkey: this.aliyunConfig.appKey
                },
                payload: {}
            };
            
            console.log('📤 发送阿里云结束识别消息:', stopMessage);
            this.websocket.send(JSON.stringify(stopMessage));
            this.isTranscriptionStarted = false;
        } else {
            console.warn('⚠️ WebSocket未连接或识别未开始，无法发送结束标志');
        }
    }

    async getBaiduAccessToken() {
        try {
            // 检查是否已有有效的token
            if (this.baiduConfig.accessToken && this.baiduConfig.tokenExpireTime > Date.now()) {
                console.log('✅ 使用缓存的百度access_token');
                return this.baiduConfig.accessToken;
            }

            console.log('🔄 获取新的百度access_token...');
            console.log('📋 请求参数:', {
                grant_type: 'client_credentials',
                client_id: this.baiduConfig.apiKey,
                client_secret: this.baiduConfig.secretKey ? '***已设置***' : '未设置',
                url: this.baiduConfig.tokenUrl
            });
            
            const params = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.baiduConfig.apiKey,
                client_secret: this.baiduConfig.secretKey
            });

            console.log('📤 发送Token请求到:', `${this.baiduConfig.tokenUrl}?${params}`);

            // 尝试使用 no-cors 模式，但这可能导致无法读取响应
            let response;
            try {
                response = await fetch(`${this.baiduConfig.tokenUrl}?${params}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
            } catch (corsError) {
                console.warn('⚠️ CORS错误，尝试no-cors模式:', corsError.message);
                // 这种模式下我们无法读取响应内容，但可以确认是否是CORS问题
                response = await fetch(`${this.baiduConfig.tokenUrl}?${params}`, {
                    method: 'POST',
                    mode: 'no-cors',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
                
                if (response.type === 'opaque') {
                    throw new Error('CORS策略阻止了请求。需要服务器端代理或百度API白名单设置。');
                }
            }

            console.log('📥 Token请求响应:', {
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                headers: Object.fromEntries(response.headers.entries())
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            console.log('📥 Token响应数据:', result);
            
            if (result.access_token) {
                this.baiduConfig.accessToken = result.access_token;
                // Token通常有效期30天，这里设置29天
                this.baiduConfig.tokenExpireTime = Date.now() + (29 * 24 * 60 * 60 * 1000);
                console.log('✅ Token获取成功:', {
                    token长度: result.access_token.length,
                    过期时间: result.expires_in ? `${result.expires_in}秒后` : '未知',
                    token前缀: result.access_token.substring(0, 20) + '...'
                });
                return result.access_token;
            } else {
                const errorMsg = result.error_description || result.error || '未知错误';
                console.error('❌ API返回错误:', {
                    error: result.error,
                    error_description: result.error_description,
                    完整响应: result
                });
                throw new Error(`API错误: ${errorMsg}`);
            }
        } catch (error) {
            console.error('❌ Token获取异常详情:', {
                错误类型: error.name,
                错误信息: error.message,
                是否网络错误: error instanceof TypeError,
                错误堆栈: error.stack
            });
            
            if (error instanceof TypeError && error.message.includes('fetch')) {
                console.error('🚫 这是CORS或网络连接问题');
            }
            
            return null;
        }
    }

    async processAudioWithBaidu(audioBlob) {
        if (!this.baiduConfig.apiKey || !this.baiduConfig.secretKey) {
            this.showDebugInfo('❌ 请配置百度API Key和Secret Key');
            return;
        }

        // 检查音频数据是否有效
        console.log('🎤 音频Blob详情:', {
            size: audioBlob.size,
            type: audioBlob.type,
            lastModified: new Date(audioBlob.lastModified || Date.now()).toLocaleTimeString()
        });
        
        if (!audioBlob || audioBlob.size === 0) {
            console.warn('⚠️ 音频数据为空，跳过处理');
            this.showDebugInfo('⚠️ 音频数据为空');
            return;
        }
        
        if (audioBlob.size < 1000) {  // 小于1KB的音频通常无效
            console.warn('⚠️ 音频数据太短，跳过处理');
            this.showDebugInfo('⚠️ 音频数据太短');
            return;
        }

        try {
            this.showDebugInfo('🔄 正在使用百度语音识别...');
            
            // 获取access_token
            const token = await this.getBaiduAccessToken();
            if (!token) {
                throw new Error('无法获取access_token');
            }
            
            console.log('✅ Access Token获取成功');

            // 转换音频为base64
            const audioBase64 = await this.blobToBase64(audioBlob);
            console.log('🎵 音频转换完成:', {
                原始大小: audioBlob.size + ' bytes',
                Base64长度: audioBase64.length,
                预期大小比例: Math.round((audioBase64.length / audioBlob.size) * 100) / 100
            });
            
            // 百度API支持的格式：pcm、wav、amr、m4a
            // 但是我们录制的是webm/opus，需要特殊处理
            const mimeType = audioBlob.type || 'audio/webm';
            let format;
            
            if (mimeType.includes('wav')) {
                format = 'wav';
            } else if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
                format = 'm4a';
            } else if (mimeType.includes('webm') || mimeType.includes('opus')) {
                // webm/opus格式，尝试告诉百度这是pcm数据
                format = 'pcm';
            } else {
                format = 'pcm'; // 默认使用pcm
            }
            
            console.log('🔍 音频格式分析:', {
                原始类型: mimeType,
                使用格式: format,
                支持状况: MediaRecorder.isTypeSupported(mimeType) ? '✅' : '❌'
            });
            
            // 准备请求参数
            // 根据格式调整参数
            let rate = 16000;
            let devPid = 1537; // 普通话（支持简单的英文识别）
            
            if (format === 'pcm') {
                // PCM格式使用更严格的参数
                rate = 16000;
                devPid = 1537;  // 普通话
            } else if (format === 'wav') {
                rate = 16000;
                devPid = 1537;
            }
            
            const requestBody = {
                format: format,
                rate: rate,        // 采样率
                channel: 1,        // 单声道
                cuid: 'roadtest_recorder_' + Date.now(), // 用户唯一标识
                token: token,
                speech: audioBase64,
                len: audioBlob.size,
                dev_pid: devPid    // 语言模型
            };

            console.log('📤 发送百度API请求...', {
                url: this.baiduConfig.asrUrl,
                bodySize: JSON.stringify(requestBody).length,
                audioSize: audioBlob.size,
                format: format
            });

            const response = await fetch(this.baiduConfig.asrUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });
            
            console.log('📥 收到百度API响应:', {
                status: response.status,
                statusText: response.statusText,
                ok: response.ok
            });

            const result = await response.json();
            console.log('📥 百度API详细响应:', {
                错误码: result.err_no,
                错误信息: result.err_msg,
                结果数组: result.result,
                完整响应: result
            });
            
            if (result.err_no === 0 && result.result && result.result.length > 0) {
                const text = result.result.join('');
                console.log('✅ 语音识别成功:', {
                    识别文本: text,
                    文本长度: text.length,
                    结果数组长度: result.result.length
                });
                this.showDebugInfo(`✅ 识别成功: "${text}"`);
                this.processVoiceInput(text);
            } else {
                const errorDetails = {
                    错误码: result.err_no,
                    错误描述: result.err_msg,
                    是否有结果: !!result.result,
                    结果长度: result.result ? result.result.length : 0
                };
                console.error('❌ 百度API识别失败详情:', errorDetails);
                this.showDebugInfo(`❌ 识别失败: [${result.err_no}] ${result.err_msg || '未知错误'}`);
            }
        } catch (error) {
            console.error('❌ 百度API调用异常:', error);
            this.showDebugInfo(`❌ API调用失败: ${error.message}`);
        }
    }

    async processAudioWithAliCloud(audioBlob) {
        if (!this.aliCloudConfig.apiKey) {
            this.showDebugInfo('❌ 请配置阿里云API Key');
            return;
        }

        try {
            this.showDebugInfo('🔄 正在识别语音...');
            
            // 转换音频为base64
            const audioBase64 = await this.blobToBase64(audioBlob);
            console.log('🎵 音频数据长度:', audioBase64.length);
            
            const requestBody = {
                model: this.aliCloudConfig.model,
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "audio",
                                    audio: audioBase64
                                },
                                {
                                    type: "text",
                                    text: "请将这段音频转换为文字，只输出转换后的文字内容，不要添加任何额外说明。"
                                }
                            ]
                        }
                    ]
                },
                parameters: {
                    result_format: "message"
                }
            };

            console.log('📤 发送API请求:', JSON.stringify(requestBody, null, 2));

            const response = await fetch(this.aliCloudConfig.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.aliCloudConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const result = await response.json();
            console.log('📥 API响应:', result);
            
            if (response.ok) {
                if (result.output && result.output.choices && result.output.choices[0] && result.output.choices[0].message && result.output.choices[0].message.content) {
                    const text = result.output.choices[0].message.content.trim();
                    this.showDebugInfo(`✅ 识别成功: "${text}"`);
                    this.processVoiceInput(text);
                } else {
                    console.error('❌ API响应格式异常:', result);
                    this.showDebugInfo(`❌ 识别失败: 响应格式异常`);
                }
            } else {
                console.error('❌ API请求失败:', result);
                this.showDebugInfo(`❌ API调用失败: ${result.message || result.error || '未知错误'}`);
            }
        } catch (error) {
            console.error('❌ 阿里云API调用异常:', error);
            console.error('错误详情:', {
                name: error.name,
                message: error.message,
                stack: error.stack
            });
            this.showDebugInfo(`❌ API调用失败: ${error.message}，降级到浏览器识别`);
            
            // API调用失败
            this.showDebugInfo(`❌ API调用失败`);
        }
    }

    async blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }


    async pollAliCloudResult(taskId) {
        const maxAttempts = 10;
        let attempts = 0;

        const poll = async () => {
            if (attempts >= maxAttempts) {
                this.showDebugInfo('❌ 识别超时');
                return;
            }

            try {
                const response = await fetch(`${this.aliCloudConfig.endpoint}/${taskId}`, {
                    headers: {
                        'Authorization': `Bearer ${this.aliCloudConfig.apiKey}`
                    }
                });

                const result = await response.json();
                
                if (result.task_status === 'SUCCEEDED' && result.results && result.results[0]) {
                    const transcription = result.results[0].transcription;
                    if (transcription) {
                        this.processVoiceInput(transcription);
                    }
                } else if (result.task_status === 'FAILED') {
                    this.showDebugInfo('❌ 识别失败');
                } else {
                    // 继续轮询
                    attempts++;
                    setTimeout(poll, 1000);
                }
            } catch (error) {
                console.error('轮询结果失败:', error);
                this.showDebugInfo('❌ 获取结果失败');
            }
        };

        poll();
    }

    processVoiceInput(text) {
        console.log('🎤 处理语音输入:', text);
        
        // 显示调试信息和实时字幕
        this.showDebugInfo(`语音识别: "${text}"`);
        this.displaySubtitle(text);
        
        // 删除/撤销指令
        if (text.includes('删除上一条') || text.includes('撤销')) {
            this.deleteLastRecord();
            this.showDebugInfo('执行删除操作');
            return;
        }

        // 直接类型匹配 - 优先级最高
        const directTypeResult = this.directTypeMatching(text);
        if (directTypeResult) {
            this.showDebugInfo(`直接匹配: ${directTypeResult.type}`);
            this.addRecord(directTypeResult.type, directTypeResult.subType, text);
            return;
        }

        // 智能识别模式 - 支持多个问题
        const smartResults = this.smartRecognitionMultiple(text);
        if (smartResults && smartResults.length > 0) {
            this.showDebugInfo(`智能识别到 ${smartResults.length} 个问题: ${smartResults.map(r => r.subType).join(', ')}`);
            smartResults.forEach(result => {
                this.addRecord(result.type, result.subType, result.matchedText || text);
            });
            return;
        }

        // 关键词模式 - 支持多个问题  
        const keywordResults = this.keywordRecognitionMultiple(text);
        if (keywordResults && keywordResults.length > 0) {
            this.showDebugInfo(`关键词识别到 ${keywordResults.length} 个问题: ${keywordResults.map(r => r.subType).join(', ')}`);
            keywordResults.forEach(result => {
                this.addRecord(result.type, result.subType, result.matchedText || text);
            });
            return;
        }
        
        // 检查是否是用户疑问或需要帮助
        const questionResult = this.handleUserQuestions(text);
        if (questionResult) {
            this.showDebugInfo(questionResult);
            return;
        }
        
        // 没有识别到任何问题
        this.showDebugInfo(`⚠️ 未识别到问题关键词: "${text}"`);
    }

    handleUserQuestions(text) {
        const cleanText = text.toLowerCase().trim();
        
        // 疑问词汇模式
        const questionPatterns = [
            { 
                patterns: ['我想知道', '想知道', '怎么', '如何', '什么', '帮助', '帮我', '我不知道', '不知道'],
                response: '💡 使用提示：说出具体问题类型，如"安全接管-压线"、"效率接管-卡死"、"体验问题-重刹"'
            },
            {
                patterns: ['有什么', '都有什么', '支持什么', '可以说什么'],
                response: '📋 支持的问题类型：安全接管(压线/碰撞/逆行)、效率接管(卡死/速度慢)、体验问题(重刹/急加速/颠簸)'
            },
            {
                patterns: ['测试', '开始', '开始测试', '怎么开始'],
                response: '🚀 点击"开始测试"按钮，然后说话描述遇到的问题即可自动记录'
            },
            {
                patterns: ['说什么', '怎么说', '格式', '怎么操作'],
                response: '🗣️ 直接说问题，如："安全接管压线"、"刹车很重"、"车子卡死了"等'
            }
        ];

        for (const pattern of questionPatterns) {
            if (pattern.patterns.some(p => cleanText.includes(p))) {
                return pattern.response;
            }
        }

        // 检查是否是空白或无意义输入
        if (cleanText.length === 0 || /^[。，,.\s]*$/.test(cleanText)) {
            return '🎤 请清楚地说出遇到的问题';
        }

        return null;
    }

    async initWebSocketConnection() {
        try {
            // 先关闭已存在的连接
            if (this.websocket && this.websocket.readyState !== WebSocket.CLOSED) {
                console.log('🔄 关闭现有WebSocket连接...');
                this.websocket.close();
                this.websocket = null;
            }
            
            console.log('🔗 初始化阿里云实时语音识别连接...');
            
            // 检查配置
            if (!this.aliyunConfig.accessKeyId || !this.aliyunConfig.accessKeySecret || !this.aliyunConfig.appKey) {
                console.warn('⚠️ 阿里云API配置未完整，等待配置...');
                this.showDebugInfo('⚠️ 等待阿里云API配置');
                return;
            }
            
            // 检查Token是否需要刷新
            if (this.aliyunTokenExpireTime && Date.now() > this.aliyunTokenExpireTime - 300000) { // 提前5分钟刷新
                console.log('🔄 Token即将过期，重新获取...');
                this.aliyunToken = null;
                this.aliyunTokenExpireTime = null;
            }
            
            // 生成阿里云认证参数
            const authParams = await this.generateAliyunAuth();
            
            // 构建WebSocket URL - 阿里云实时语音识别规范格式
            let wsUrl;
            if (authParams) {
                // 带认证的URL - 正确的参数顺序
                wsUrl = `wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1?appkey=${this.aliyunConfig.appKey}&${authParams}`;
            } else {
                // 无认证的URL（通常需要在其他地方进行认证）
                console.warn('⚠️ 无认证Token，可能导致连接失败');
                wsUrl = `wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1?appkey=${this.aliyunConfig.appKey}`;
            }
            
            console.log('📡 连接阿里云WebSocket...', wsUrl);
            this.websocket = new WebSocket(wsUrl);
            
            // 设置连接超时
            const connectionTimeout = setTimeout(() => {
                if (this.websocket && this.websocket.readyState === WebSocket.CONNECTING) {
                    console.log('⏰ WebSocket连接超时');
                    this.websocket.close();
                }
            }, 10000); // 10秒超时
            
            this.websocket.onopen = () => {
                clearTimeout(connectionTimeout);
                console.log('✅ 阿里云WebSocket连接已建立');
                this.showDebugInfo('✅ 阿里云实时语音识别已连接');
                this.aliyunConnectionReady = true;
                this.wsReconnectAttempts = 0; // 重置重试计数
                
                // 发送开始识别消息
                this.sendStartMessage();
            };
            
            this.websocket.onmessage = (event) => {
                this.handleAliyunWebSocketMessage(event.data);
            };
            
            this.websocket.onclose = (event) => {
                clearTimeout(connectionTimeout);
                console.log('🔌 阿里云WebSocket连接关闭:', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean
                });
                
                this.aliyunConnectionReady = false;
                
                // 根据错误码判断处理方式
                if (event.code === 4402) {
                    console.error('❌ 认证失败 (4402)，检查Token和配置');
                    this.showDebugInfo('❌ 认证失败，请检查阿里云配置');
                    // 认证失败不重试，需要用户检查配置
                    return;
                } else if (event.code === 1006 || event.reason.includes('over max connect limit')) {
                    console.log('⚠️ 检测到连接数限制，延迟重试...');
                    this.showDebugInfo('⚠️ 连接数限制，等待重试');
                    setTimeout(() => {
                        this.handleWebSocketReconnect();
                    }, this.connectionRetryDelay);
                } else if (event.code === 1000) {
                    console.log('✅ WebSocket正常关闭');
                    this.showDebugInfo('✅ 语音识别连接已关闭');
                } else {
                    console.log(`⚠️ WebSocket异常关闭 (${event.code})，尝试重连`);
                    this.handleWebSocketReconnect();
                }
            };
            
            this.websocket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                console.error('❌ 阿里云WebSocket错误:', error);
                this.showDebugInfo('❌ 阿里云WebSocket连接错误');
            };
            
        } catch (error) {
            console.error('❌ 阿里云WebSocket初始化失败:', error);
            this.showDebugInfo('❌ 阿里云WebSocket初始化失败');
        }
    }

    async generateAliyunAuth() {
        try {
            // 阿里云实时语音识别使用Token认证
            console.log('🔐 获取阿里云语音识别Token...');
            
            // 正确的时间戳格式 - UTC格式
            const now = new Date();
            const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
            const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            
            console.log('🕐 生成的时间戳:', timestamp);
            console.log('🔢 生成的随机数:', nonce);
            
            // 构建请求参数
            const params = {
                AccessKeyId: this.aliyunConfig.accessKeyId,
                Action: 'CreateToken',
                Format: 'JSON',  
                RegionId: 'cn-shanghai',
                SignatureMethod: 'HMAC-SHA1',
                SignatureNonce: nonce,
                SignatureVersion: '1.0',
                Timestamp: timestamp,
                Version: '2019-02-28'
            };
            
            // 按字典序排序参数 - 确保正确编码
            const sortedKeys = Object.keys(params).sort();
            const sortedParams = sortedKeys.map(key => 
                `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
            ).join('&');
            
            console.log('📋 排序后的参数:', sortedParams);
            
            // 构建签名字符串 - 按照阿里云规范
            const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(sortedParams)}`;
            console.log('📝 签名字符串:', stringToSign);
            
            // 生成签名 - 注意密钥格式
            const signingKey = this.aliyunConfig.accessKeySecret + '&';
            const signature = await this.hmacSha1(stringToSign, signingKey);
            
            console.log('🔐 生成的签名:', signature);
            
            // 请求Token
            const tokenUrl = `https://nls-meta.cn-shanghai.aliyuncs.com/?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
            
            console.log('📡 请求Token URL:', tokenUrl.replace(this.aliyunConfig.accessKeyId, 'ACCESS_KEY_HIDDEN'));
            
            const response = await fetch(tokenUrl);
            console.log('📥 Token请求响应状态:', response.status, response.statusText);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ Token请求失败:', response.status, errorText);
                throw new Error(`Token请求失败: ${response.status} ${errorText}`);
            }
            
            const data = await response.json();
            console.log('📥 Token响应数据:', data);
            
            if (data.Token && data.Token.Id) {
                console.log('✅ 获取Token成功:', data.Token.Id.substring(0, 20) + '...');
                this.aliyunToken = data.Token.Id;
                this.aliyunTokenExpireTime = data.Token.ExpireTime; // 保存过期时间
                return `token=${data.Token.Id}`;
            } else if (data.Code) {
                console.error('❌ 阿里云API错误:', {
                    错误代码: data.Code,
                    错误消息: data.Message,
                    请求ID: data.RequestId
                });
                throw new Error(`阿里云API错误: ${data.Code} - ${data.Message}`);
            } else {
                console.error('❌ Token响应格式异常:', data);
                throw new Error('Token响应格式异常');
            }
            
        } catch (error) {
            console.error('❌ 生成阿里云认证失败:', {
                错误类型: error.name,
                错误消息: error.message,
                错误堆栈: error.stack
            });
            return '';
        }
    }

    // HMAC-SHA256签名方法
    async hmacSha256(text, key) {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(key);
        const messageData = encoder.encode(text);
        
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        
        const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
        return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    }

    // HMAC-SHA1签名方法 (阿里云需要)
    async hmacSha1(text, key) {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(key);
        const messageData = encoder.encode(text);
        
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-1' },
            false,
            ['sign']
        );
        
        const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
        return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    }

    // 发送开始识别消息
    sendStartMessage() {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            // 生成唯一的task_id
            this.currentTaskId = this.generateTaskId();
            
            const startMessage = {
                header: {
                    message_id: this.generateMessageId(),
                    task_id: this.currentTaskId,
                    namespace: 'SpeechTranscriber',
                    name: 'StartTranscription',
                    appkey: this.aliyunConfig.appKey
                },
                payload: {
                    format: 'pcm',
                    sample_rate: 16000,
                    enable_intermediate_result: true,
                    enable_punctuation_prediction: true,
                    enable_inverse_text_normalization: true,
                    enable_words: false // 是否返回词级别时间戳
                }
            };
            
            console.log('📤 发送开始识别消息:', startMessage);
            this.websocket.send(JSON.stringify(startMessage));
            this.isTranscriptionStarted = true;
        } else {
            console.error('❌ WebSocket未连接，无法发送开始消息');
        }
    }

    // 处理阿里云WebSocket消息
    handleAliyunWebSocketMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('📥 收到阿里云WebSocket消息:', message);
            
            const header = message.header;
            const payload = message.payload;
            
            // 检查错误状态码
            if (header.status && header.status !== 20000000) {
                console.error('❌ 阿里云API错误:', {
                    状态码: header.status,
                    状态信息: header.status_text,
                    消息ID: header.message_id,
                    任务ID: header.task_id
                });
                
                // 处理特定错误码
                switch (header.status) {
                    case 40000000:
                        this.showDebugInfo('❌ 客户端错误：参数无效');
                        break;
                    case 40000001:
                        this.showDebugInfo('❌ 客户端错误：任务不存在');
                        break;
                    case 40000002:
                        this.showDebugInfo('❌ 客户端错误：任务已完成');
                        break;
                    case 40000003:
                        this.showDebugInfo('❌ 客户端错误：任务正在处理中');
                        break;
                    case 40400018:
                        this.showDebugInfo('❌ 认证错误：Token无效或已过期');
                        break;
                    case 50000000:
                        this.showDebugInfo('❌ 服务器内部错误');
                        break;
                    default:
                        this.showDebugInfo(`❌ 未知错误: ${header.status} - ${header.status_text}`);
                }
                return;
            }
            
            // 处理正常消息
            if (header.name === 'TranscriptionStarted') {
                console.log('✅ 阿里云识别会话已开始');
                this.showDebugInfo('✅ 阿里云识别会话已开始');
            } else if (header.name === 'TranscriptionResultChanged') {
                // 中间识别结果
                const transcript = payload.result;
                console.log('🎤 中间识别结果:', transcript);
                this.displaySubtitle(transcript);
            } else if (header.name === 'SentenceEnd') {
                // 最终识别结果
                const transcript = payload.result;
                console.log('✅ 最终识别结果:', transcript);
                this.displaySubtitle(transcript);
                // 处理语音输入
                this.processVoiceInput(transcript);
            } else if (header.name === 'TranscriptionCompleted') {
                console.log('✅ 阿里云识别完成');
                this.showDebugInfo('✅ 语音识别完成');
            } else {
                console.log('📢 其他阿里云消息:', message);
            }
            
        } catch (error) {
            console.error('❌ 处理阿里云WebSocket消息失败:', {
                错误类型: error.name,
                错误信息: error.message,
                原始数据: data,
                错误堆栈: error.stack
            });
        }
    }

    // 生成符合阿里云要求的32位十六进制ID
    generate32HexId() {
        let result = '';
        const characters = '0123456789abcdef';
        for (let i = 0; i < 32; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }

    generateMessageId() {
        return this.generate32HexId();
    }

    generateTaskId() {
        return this.generate32HexId();
    }



    sendStartFrame(token) {
        const startFrame = {
            type: "START",
            data: {
                appid: parseInt(this.baiduConfig.appId),
                appkey: this.baiduConfig.apiKey,
                dev_pid: 1537, // 修正：普通话模型
                cuid: "web_client_" + Date.now(),
                sample: 16000, // 采样率
                format: "pcm", // 音频格式
                token: token
            }
        };
        
        console.log('📤 发送START帧:', startFrame);
        this.websocket.send(JSON.stringify(startFrame));
        
        // 等待服务器响应START_ACK
        setTimeout(() => {
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                console.log('🔍 WebSocket连接状态良好，等待识别结果');
            }
        }, 1000);
    }

    handleWebSocketMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('📥 收到WebSocket消息:', message);
            
            switch (message.type) {
                case 'CONNECT_OK':
                    console.log('✅ WebSocket连接确认');
                    break;
                    
                case 'START_OK':
                    console.log('✅ START帧确认，开始发送音频');
                    break;
                    
                case 'MID_TEXT':
                    // 中间识别结果
                    if (message.result && message.result.length > 0) {
                        const text = message.result.join('');
                        console.log('🔄 中间识别结果:', text);
                        this.displaySubtitle(text);
                    }
                    break;
                    
                case 'FIN_TEXT':
                    // 最终识别结果
                    if (message.result && message.result.length > 0) {
                        const text = message.result.join('');
                        console.log('✅ 最终识别结果:', text);
                        this.displaySubtitle(text);
                        this.processVoiceInput(text);
                    }
                    break;
                    
                case 'ERROR':
                    console.error('❌ WebSocket识别错误:', message);
                    this.showDebugInfo(`❌ 识别错误: ${message.desc || message.err_msg || '未知错误'}`);
                    break;
                    
                case 'HEARTBEAT':
                    // 心跳包，正常
                    break;
                    
                default:
                    console.log('📢 其他WebSocket消息:', message);
            }
        } catch (error) {
            console.error('❌ 解析WebSocket消息失败:', error, data);
        }
    }

    handleWebSocketReconnect() {
        if (this.wsReconnectAttempts < this.maxReconnectAttempts) {
            this.wsReconnectAttempts++;
            console.log(`🔄 尝试重新连接WebSocket (${this.wsReconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => {
                this.initWebSocketConnection();
            }, 2000 * this.wsReconnectAttempts);
        } else {
            console.error('❌ WebSocket重连次数超限');
            this.showDebugInfo('❌ 语音识别连接失败');
        }
    }

    async sendAudioDataToWebSocket(audioBlob) {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            console.warn('⚠️ 阿里云WebSocket未就绪，跳过音频发送');
            return;
        }
        
        if (!this.isTranscriptionStarted) {
            console.warn('⚠️ 识别未开始，跳过音频发送');
            return;
        }

        try {
            // 将WebM音频转换为PCM格式
            const pcmData = await this.convertWebMToPCM(audioBlob);
            
            if (pcmData && pcmData.length > 0) {
                console.log('📡 发送PCM音频数据到阿里云:', {
                    原始大小: audioBlob.size + ' bytes',
                    PCM大小: pcmData.length + ' bytes', 
                    WebSocket状态: this.websocket.readyState,
                    格式: 'PCM 16kHz 16bit mono'
                });
                
                // 阿里云WebSocket API支持直接发送二进制PCM数据
                // 也可以使用JSON格式封装，但二进制更高效
                this.websocket.send(pcmData);
                
                // 可选：发送JSON格式的音频数据（如果需要）
                /*
                const audioMessage = {
                    header: {
                        message_id: this.generateMessageId(),
                        task_id: this.currentTaskId,
                        namespace: 'SpeechTranscriber',
                        name: 'RunTranscription',
                        appkey: this.aliyunConfig.appKey
                    },
                    payload: {
                        audio: btoa(String.fromCharCode(...pcmData)) // base64编码
                    }
                };
                this.websocket.send(JSON.stringify(audioMessage));
                */
                
            } else {
                console.warn('⚠️ PCM转换失败，跳过发送');
            }
            
        } catch (error) {
            console.error('❌ 发送音频数据到阿里云失败:', error);
        }
    }

    // 直接发送PCM数据到阿里云
    sendPCMDataDirectly(float32Array) {
        try {
            // 将Float32转换为Int16 PCM
            const int16Array = new Int16Array(float32Array.length);
            for (let i = 0; i < float32Array.length; i++) {
                const sample = Math.max(-1, Math.min(1, float32Array[i]));
                int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }
            
            // 转换为字节数组
            const pcmBytes = new Uint8Array(int16Array.buffer);
            
            // 发送到阿里云 (支持直接发送二进制数据)
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.send(pcmBytes);
                
                // 定期显示发送状态
                if (this.pcmSendCount % 50 === 0) { // 每50次显示一次
                    console.log('📡 发送PCM数据到阿里云:', {
                        样本数: float32Array.length,
                        PCM字节数: pcmBytes.length,
                        发送次数: this.pcmSendCount
                    });
                }
                this.pcmSendCount = (this.pcmSendCount || 0) + 1;
            }
        } catch (error) {
            console.error('❌ 发送PCM数据失败:', error);
        }
    }

    // 将WebM/Opus音频转换为PCM 16kHz 16bit mono
    async convertWebMToPCM(audioBlob) {
        try {
            // 使用Web Audio API进行格式转换
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000 // 阿里云要求16kHz采样率
            });
            
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            
            // 转换为单声道
            const samples = audioBuffer.numberOfChannels > 1 ? 
                audioBuffer.getChannelData(0) : audioBuffer.getChannelData(0);
            
            // 转换为16bit PCM
            const pcm16Buffer = new Int16Array(samples.length);
            for (let i = 0; i < samples.length; i++) {
                // 将float32转换为int16
                const sample = Math.max(-1, Math.min(1, samples[i]));
                pcm16Buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }
            
            console.log('🔄 音频格式转换完成:', {
                原始通道数: audioBuffer.numberOfChannels,
                原始采样率: audioBuffer.sampleRate + 'Hz',
                目标采样率: '16000Hz',
                PCM样本数: pcm16Buffer.length
            });
            
            return new Uint8Array(pcm16Buffer.buffer);
            
        } catch (error) {
            console.error('❌ 音频格式转换失败:', error);
            return null;
        }
    }

    // 按照阿里云API建议分块发送PCM数据
    async sendPCMInChunks(pcmData) {
        const chunkSize = 1280; // 分块发送的大小
        let offset = 0;
        
        while (offset < pcmData.length) {
            const chunk = pcmData.slice(offset, offset + chunkSize);
            
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.send(chunk);
            } else {
                console.warn('⚠️ WebSocket连接断开，停止发送');
                break;
            }
            
            offset += chunkSize;
            
            // 模拟40ms间隔（实际上MediaRecorder会控制发送频率）
            if (offset < pcmData.length) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
    }

    // 设置阿里云API配置的方法
    setAliyunConfig(accessKeyId, accessKeySecret, appKey, wsUrl) {
        this.aliyunConfig.accessKeyId = accessKeyId;
        this.aliyunConfig.accessKeySecret = accessKeySecret;
        this.aliyunConfig.appKey = appKey;
        this.aliyunConfig.wsUrl = wsUrl;
        
        console.log('✅ 阿里云API配置已更新:', {
            accessKeyId: accessKeyId ? `${accessKeyId.substring(0, 8)}...` : '未设置',
            accessKeySecret: accessKeySecret ? '已设置' : '未设置',
            appKey: appKey || '未设置',
            wsUrl: wsUrl || '未设置'
        });
        
        // 配置完成后立即初始化连接
        this.showDebugInfo('🔧 阿里云配置已更新');
    }



    // 测试阿里云API连接
    testAliyunAPIConnection() {
        console.log('🔍 测试阿里云API连接...');
        
        if (!this.aliyunConfig.accessKeyId || !this.aliyunConfig.accessKeySecret || !this.aliyunConfig.appKey) {
            console.log('⏸️ 阿里云API配置未完整，等待配置');
            this.showDebugInfo('⏸️ 等待阿里云API配置');
            return;
        }

        console.log('📋 阿里云API配置验证:', {
            accessKeyId: this.aliyunConfig.accessKeyId ? `${this.aliyunConfig.accessKeyId.substring(0, 8)}...` : '未设置',
            accessKeySecret: this.aliyunConfig.accessKeySecret ? '已设置' : '未设置',
            appKey: this.aliyunConfig.appKey || '未设置',
            wsUrl: this.aliyunConfig.wsUrl || '未设置',
            当前Token: this.aliyunToken ? `${this.aliyunToken.substring(0, 20)}...` : '未获取',
            Token过期时间: this.aliyunTokenExpireTime ? new Date(this.aliyunTokenExpireTime).toLocaleString() : '未知'
        });
        
        this.showDebugInfo('🔍 正在测试阿里云API连接');
        this.initWebSocketConnection();
    }
    
    // 验证配置完整性
    validateAliyunConfig() {
        const issues = [];
        
        if (!this.aliyunConfig.accessKeyId) {
            issues.push('AccessKeyId未配置');
        } else if (this.aliyunConfig.accessKeyId.length < 16) {
            issues.push('AccessKeyId格式可能不正确');
        }
        
        if (!this.aliyunConfig.accessKeySecret) {
            issues.push('AccessKeySecret未配置');
        } else if (this.aliyunConfig.accessKeySecret.length < 20) {
            issues.push('AccessKeySecret格式可能不正确');
        }
        
        if (!this.aliyunConfig.appKey) {
            issues.push('AppKey未配置');
        }
        
        if (issues.length > 0) {
            console.warn('⚠️ 阿里云配置问题:', issues);
            this.showDebugInfo(`⚠️ 配置问题: ${issues.join(', ')}`);
            return false;
        }
        
        console.log('✅ 阿里云配置验证通过');
        return true;
    }

    

    displaySubtitle(text) {
        // 等待DOM准备就绪
        if (document.readyState !== 'complete') {
            setTimeout(() => this.displaySubtitle(text), 100);
            return;
        }
        
        const subtitleDiv = document.querySelector('.subtitle-text');
        const historyContent = document.getElementById('historyContent');
        
        // 检查DOM元素是否存在
        if (!subtitleDiv) {
            console.warn('⚠️ 字幕显示元素未找到，尝试fallback方案');
            // 尝试fallback方案：直接更新recognitionDisplay
            const fallbackDiv = document.getElementById('recognitionDisplay');
            if (fallbackDiv) {
                fallbackDiv.innerHTML = `<div class="subtitle-text">"${this.highlightKeywords(text)}"</div>`;
            }
            return;
        }
        
        if (!text || text.trim() === '') {
            subtitleDiv.innerHTML = '🎤 等待语音输入...';
            return;
        }
        
        // 高亮关键词
        const highlightedText = this.highlightKeywords(text);
        subtitleDiv.innerHTML = `"${highlightedText}"`;
        
        // 添加到历史记录
        this.addToVoiceHistory(text, highlightedText);
        
        // 3秒后清空当前字幕
        setTimeout(() => {
            if (subtitleDiv.innerHTML.includes(highlightedText)) {
                subtitleDiv.innerHTML = '🎤 等待语音输入...';
            }
        }, 3000);
    }

    highlightKeywords(text) {
        let highlighted = text;
        
        // 安全接管关键词 - 红色
        const safetyKeywords = ['安全接管', '安全', '压线', '碰撞', '撞', '危险', '逆行', '闯红灯', '红灯'];
        safetyKeywords.forEach(keyword => {
            const regex = new RegExp(keyword, 'gi');
            highlighted = highlighted.replace(regex, `<span class="keyword-safety">${keyword}</span>`);
        });
        
        // 效率接管关键词 - 橙色
        const efficiencyKeywords = ['效率接管', '效率', '卡死', '卡住', '不动', '慢', '龟速', '反应慢', '迟钝'];
        efficiencyKeywords.forEach(keyword => {
            const regex = new RegExp(keyword, 'gi');
            highlighted = highlighted.replace(regex, `<span class="keyword-efficiency">${keyword}</span>`);
        });
        
        // 体验问题关键词 - 紫色
        const experienceKeywords = ['体验问题', '体验', '重刹', '刹车', '急加速', '加速', '颠簸', '震动', '画龙', '蛇行'];
        experienceKeywords.forEach(keyword => {
            const regex = new RegExp(keyword, 'gi');
            highlighted = highlighted.replace(regex, `<span class="keyword-experience">${keyword}</span>`);
        });
        
        // 动作关键词 - 青色
        const actionKeywords = ['删除', '撤销', '开始', '停止', '暂停'];
        actionKeywords.forEach(keyword => {
            const regex = new RegExp(keyword, 'gi');
            highlighted = highlighted.replace(regex, `<span class="keyword-action">${keyword}</span>`);
        });
        
        return highlighted;
    }

    addToVoiceHistory(originalText, highlightedText) {
        const historyContent = document.getElementById('historyContent');
        
        // 检查历史记录元素是否存在
        if (!historyContent) {
            console.warn('⚠️ 历史记录元素未找到');
            return;
        }
        
        const timestamp = new Date().toLocaleTimeString();
        
        // 确定历史项目的类型
        let itemClass = 'normal';
        if (originalText.includes('安全') || originalText.includes('危险') || originalText.includes('碰撞')) {
            itemClass = 'error';
        } else if (originalText.includes('效率') || originalText.includes('卡死')) {
            itemClass = 'warning';
        } else if (this.isSuccessfulMatch(originalText)) {
            itemClass = 'success';
        }
        
        const historyItem = document.createElement('div');
        historyItem.className = `history-item ${itemClass}`;
        historyItem.innerHTML = `
            <span class="timestamp">${timestamp}</span>
            ${highlightedText}
        `;
        
        // 插入到顶部
        historyContent.insertBefore(historyItem, historyContent.firstChild);
        
        // 限制历史记录数量
        const items = historyContent.children;
        if (items.length > 10) {
            historyContent.removeChild(items[items.length - 1]);
        }
        
        // 滚动到顶部显示最新记录
        historyContent.scrollTop = 0;
    }

    isSuccessfulMatch(text) {
        // 检查是否成功匹配到问题类型
        const directResult = this.directTypeMatching(text);
        const smartResults = this.smartRecognitionMultiple(text);
        const keywordResults = this.keywordRecognitionMultiple(text);
        
        return directResult || (smartResults && smartResults.length > 0) || (keywordResults && keywordResults.length > 0);
    }

    directTypeMatching(text) {
        // 更强的文本清理：处理全角半角、多种空格和标点
        let cleanText = text
            .replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, '') // 各种空格
            .replace(/[，,。.！!？?；;：:""''「」【】（）()]/g, '') // 中英文标点
            .toLowerCase()
            .trim();
        
        console.log(`🔍 DirectTypeMatching - 原文: "${text}" → 清理后: "${cleanText}"`);
        
        // 直接类型匹配 - 最高优先级，使用更宽松的匹配策略
        const directMatches = [
            // 安全接管类 - 增加更多变体和容错
            { 
                patterns: [
                    '安全接管', '安全问题', '安全', 
                    'safety', '接管安全', '安全的接管',
                    '安全事件', '安全状况', '安全情况'
                ], 
                type: '安全接管', 
                subType: '安全接管' 
            },
            
            // 效率接管类  
            { 
                patterns: [
                    '效率接管', '效率问题', '效率', 
                    'efficiency', '接管效率', '效率的接管',
                    '效率事件', '效率状况', '效率情况'
                ], 
                type: '效率接管', 
                subType: '效率接管' 
            },
            
            // 体验问题类
            { 
                patterns: [
                    '体验问题', '体验', 'experience', '体验不好',
                    '体验事件', '体验状况', '体验情况', '用户体验'
                ], 
                type: '体验问题', 
                subType: '体验问题' 
            }
        ];

        // 精确匹配
        for (const match of directMatches) {
            for (const pattern of match.patterns) {
                const cleanPattern = pattern.toLowerCase().replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, '');
                if (cleanText === cleanPattern || cleanText.includes(cleanPattern)) {
                    console.log(`✅ 直接匹配成功: "${pattern}" → ${match.type}`);
                    return { type: match.type, subType: match.subType };
                }
            }
        }

        // 模糊匹配 - 容错机制
        const fuzzyMatches = [
            { fuzzyPatterns: ['安全'], type: '安全接管', subType: '安全接管', minLength: 2 },
            { fuzzyPatterns: ['效率'], type: '效率接管', subType: '效率接管', minLength: 2 },
            { fuzzyPatterns: ['体验'], type: '体验问题', subType: '体验问题', minLength: 2 }
        ];

        for (const match of fuzzyMatches) {
            for (const pattern of match.fuzzyPatterns) {
                if (cleanText.includes(pattern) && cleanText.length >= match.minLength) {
                    console.log(`🎯 模糊匹配成功: "${pattern}" → ${match.type}`);
                    return { type: match.type, subType: match.subType };
                }
            }
        }

        console.log(`❌ 直接匹配失败: "${cleanText}"`);
        return null;
    }

    smartRecognition(text) {
        // 体验问题智能识别
        const experiencePatterns = [
            { pattern: /(画龙|龙|蛇行|摆尾)/, subType: '画龙' },
            { pattern: /(重刹|刹车重|急刹|制动重)/, subType: '重刹' },
            { pattern: /(急加速|加速急|冲击)/, subType: '急加速' },
            { pattern: /(颠簸|震动|不平稳)/, subType: '颠簸' },
            { pattern: /(转向重|方向盘重|打方向重)/, subType: '转向重' }
        ];

        // 效率接管智能识别
        const efficiencyPatterns = [
            { pattern: /(卡死|卡住|不动|停住)/, subType: '卡死不动' },
            { pattern: /(慢|龟速|太慢|速度慢)/, subType: '速度过慢' },
            { pattern: /(反应慢|迟钝|延迟)/, subType: '反应迟钝' },
            { pattern: /(路径错误|走错|路线错)/, subType: '路径错误' }
        ];

        // 安全接管智能识别
        const safetyPatterns = [
            { pattern: /(碰撞|撞|危险)/, subType: '碰撞风险' },
            { pattern: /(压线|越线|跨线)/, subType: '压线' },
            { pattern: /(逆行|反向)/, subType: '逆行' },
            { pattern: /(闯红灯|红灯)/, subType: '闯红灯' }
        ];

        // 检查体验问题
        for (const pattern of experiencePatterns) {
            if (pattern.pattern.test(text)) {
                return { type: '体验问题', subType: pattern.subType };
            }
        }

        // 检查效率接管
        for (const pattern of efficiencyPatterns) {
            if (pattern.pattern.test(text)) {
                return { type: '效率接管', subType: pattern.subType };
            }
        }

        // 检查安全接管
        for (const pattern of safetyPatterns) {
            if (pattern.pattern.test(text)) {
                return { type: '安全接管', subType: pattern.subType };
            }
        }

        return null;
    }

    keywordRecognition(text) {
        // 体验问题关键词匹配
        let match = text.match(/体验问题[-－](.+)/);
        if (match) {
            return { type: '体验问题', subType: match[1].trim() };
        }

        // 安全接管关键词匹配
        match = text.match(/安全接管[-－](.+)/);
        if (match) {
            return { type: '安全接管', subType: match[1].trim() };
        }

        // 效率接管关键词匹配
        match = text.match(/效率接管[-－](.+)/);
        if (match) {
            return { type: '效率接管', subType: match[1].trim() };
        }

        return null;
    }

    smartRecognitionMultiple(text) {
        const results = [];
        
        // 体验问题智能识别 - 扩展同义词和变体
        const experiencePatterns = [
            { pattern: /(画龙|画蛇|龙|蛇行|摆尾|左右摆|摇摆)/, subType: '画龙' },
            { pattern: /(重刹|刹车重|急刹|制动重|刹车|急停|突然刹车)/, subType: '重刹' },
            { pattern: /(急加速|加速急|冲击|突然加速|猛加速|提速快)/, subType: '急加速' },
            { pattern: /(颠簸|震动|不平稳|抖动|摇晃|晃动|不稳)/, subType: '颠簸' },
            { pattern: /(转向重|方向盘重|打方向重|方向重|转向沉|打方向沉)/, subType: '转向重' }
        ];

        // 效率接管智能识别 - 扩展同义词和变体
        const efficiencyPatterns = [
            { pattern: /(卡死|卡住|不动|停住|卡顿|死机|停车|不走)/, subType: '卡死不动' },
            { pattern: /(慢|龟速|太慢|速度慢|很慢|超慢|开得慢|跑得慢)/, subType: '速度过慢' },
            { pattern: /(反应慢|迟钝|延迟|反应迟钝|响应慢|慢半拍)/, subType: '反应迟钝' },
            { pattern: /(路径错误|走错|路线错|路径错|走错路|线路错)/, subType: '路径错误' },
            { pattern: /(效率接管|效率问题|效率|efficiency)/, subType: '效率接管' }
        ];

        // 安全接管智能识别 - 扩展同义词和变体  
        const safetyPatterns = [
            { pattern: /(碰撞|撞|危险|要撞|快撞|撞车|碰车)/, subType: '碰撞风险' },
            { pattern: /(压线|越线|跨线|踩线|出线|过线)/, subType: '压线' },
            { pattern: /(逆行|反向|开反了|走反|方向反)/, subType: '逆行' },
            { pattern: /(闯红灯|红灯|冲红灯|闯灯)/, subType: '闯红灯' },
            { pattern: /(安全接管|安全问题|安全|safety)/, subType: '安全接管' }
        ];

        // 检查体验问题
        experiencePatterns.forEach(pattern => {
            const match = text.match(pattern.pattern);
            if (match) {
                results.push({ 
                    type: '体验问题', 
                    subType: pattern.subType,
                    matchedText: match[0]
                });
            }
        });

        // 检查效率接管
        efficiencyPatterns.forEach(pattern => {
            const match = text.match(pattern.pattern);
            if (match) {
                results.push({ 
                    type: '效率接管', 
                    subType: pattern.subType,
                    matchedText: match[0]
                });
            }
        });

        // 检查安全接管
        safetyPatterns.forEach(pattern => {
            const match = text.match(pattern.pattern);
            if (match) {
                results.push({ 
                    type: '安全接管', 
                    subType: pattern.subType,
                    matchedText: match[0]
                });
            }
        });

        return results.length > 0 ? results : null;
    }

    keywordRecognitionMultiple(text) {
        const results = [];
        
        // 体验问题关键词匹配
        let matches = text.match(/体验问题[-－]([^，,；;。.!！\s]+)/g);
        if (matches) {
            matches.forEach(match => {
                const subType = match.replace(/体验问题[-－]/, '').trim();
                if (subType) {
                    results.push({ 
                        type: '体验问题', 
                        subType: subType,
                        matchedText: match
                    });
                }
            });
        }

        // 安全接管关键词匹配
        matches = text.match(/安全接管[-－]([^，,；;。.!！\s]+)/g);
        if (matches) {
            matches.forEach(match => {
                const subType = match.replace(/安全接管[-－]/, '').trim();
                if (subType) {
                    results.push({ 
                        type: '安全接管', 
                        subType: subType,
                        matchedText: match
                    });
                }
            });
        }

        // 效率接管关键词匹配
        matches = text.match(/效率接管[-－]([^，,；;。.!！\s]+)/g);
        if (matches) {
            matches.forEach(match => {
                const subType = match.replace(/效率接管[-－]/, '').trim();
                if (subType) {
                    results.push({ 
                        type: '效率接管', 
                        subType: subType,
                        matchedText: match
                    });
                }
            });
        }

        return results.length > 0 ? results : null;
    }

    addRecord(type, subType, originalText) {
        if (!this.currentSession) return;

        // 去重检查：防止5秒内添加相同类型和子类型的记录
        const now = Date.now();
        const currentSessionRecords = this.getCurrentSessionRecords();
        const recentSimilar = currentSessionRecords.find(record => 
            record.type === type && 
            record.subType === subType &&
            (now - new Date(record.timestamp).getTime()) < 5000
        );

        if (recentSimilar) {
            console.log('跳过重复记录:', type, subType);
            return;
        }

        const record = {
            id: now,
            timestamp: new Date().toISOString(),
            type: type,
            subType: subType,
            originalText: originalText,
            sessionId: this.currentSession.id,
            sessionName: this.currentSession.name
        };

        this.testData.push(record);
        this.saveData();
        this.updateUI();
        this.showRecordNotification(record);
    }

    deleteLastRecord() {
        if (this.testData.length === 0) return;

        const lastRecord = this.testData.pop();
        this.saveData();
        this.updateUI();
        this.showDeleteNotification(lastRecord);
    }


    generateSessionName() {
        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const hour = now.getHours().toString().padStart(2, '0');
        const minute = now.getMinutes().toString().padStart(2, '0');
        const second = now.getSeconds().toString().padStart(2, '0');
        
        return `测试_${year}${month}${day}_${hour}${minute}${second}`;
    }

    startTest() {
        console.log('🎬 startTest被调用', {
            isRecording: this.isRecording,
            currentState: this.state,
            expectedState: RoadTestRecorder.STATES.STOPPED
        });
        
        if (this.isRecording || this.state !== RoadTestRecorder.STATES.STOPPED) {
            console.log('⚠️ 测试启动条件不满足');
            return;
        }

        this.state = RoadTestRecorder.STATES.STARTING;
        const sessionId = Date.now();
        const sessionName = this.generateSessionName();
        
        this.currentSession = {
            id: sessionId,
            name: sessionName,
            startTime: new Date().toISOString(),
            endTime: null,
            recordCount: 0
        };

        this.isRecording = true;
        this.state = RoadTestRecorder.STATES.RECORDING;
        this.startTime = Date.now();
        this.startTimer();
        
        // 语音识别方案选择 - 使用阿里云API
        console.log('🔍 语音识别方案选择...');
        
        // 检查阿里云API配置
        const hasAliyunConfig = this.aliyunConfig.accessKeyId && this.aliyunConfig.accessKeySecret && this.aliyunConfig.appKey;
        console.log('🔑 阿里云API配置状态:', hasAliyunConfig ? '已配置' : '未配置');
        
        if (hasAliyunConfig) {
            console.log('☁️ 使用阿里云语音识别API');
            this.showDebugInfo('☁️ 使用阿里云语音识别');
            // 确保WebSocket连接已建立
            if (!this.aliyunConnectionReady) {
                console.log('📡 WebSocket未就绪，先建立连接...');
                this.initWebSocketConnection();
            }
            this.startAudioRecording();
        } else {
            console.error('❌ 阿里云API未配置，无法启动语音识别');
            this.showDebugInfo('❌ 阿里云API未配置');
            this.showNotification('请先配置阿里云语音识别API');
            
            // 提示用户配置阿里云API
            console.log('⚠️ 需要配置阿里云API凭证');
            this.showConfigModal();
            
            // 配置完成后启动
            setTimeout(() => {
                this.initWebSocketConnection();
                this.startAudioRecording();
            }, 1000);
        }

        this.updateUI();
        this.showNotification('开始测试记录');
    }

    pauseTest() {
        if (!this.isRecording || this.state !== RoadTestRecorder.STATES.RECORDING) return;
        
        this.state = RoadTestRecorder.STATES.PAUSING;
        this.isRecording = false;
        this.stopTimer();
        
        // 停止录音和语音识别
        this.stopAudioRecording();
        
        this.state = RoadTestRecorder.STATES.STOPPED;
        this.updateUI();
        this.showNotification('测试已暂停');
    }

    stopTest() {
        if (!this.isRecording) return;

        this.state = RoadTestRecorder.STATES.PAUSING;
        this.isRecording = false;
        this.stopTimer();
        
        if (this.currentSession) {
            this.currentSession.endTime = new Date().toISOString();
            // 统计本次测试的记录数量
            this.currentSession.recordCount = this.getCurrentSessionRecords().length;
            
            // 保存到测试历史
            this.testSessions.push({ ...this.currentSession });
            this.saveSessionData();
        }

        // 停止录音和语音识别
        this.stopAudioRecording();

        this.state = RoadTestRecorder.STATES.STOPPED;
        this.updateUI();
        this.showNotification(`测试记录已停止 - ${this.currentSession?.name}`);
    }
    
    startTimer() {
        this.timerInterval = setInterval(() => {
            this.updateTimer();
        }, 1000);
    }
    
    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    
    updateTimer() {
        if (!this.startTime) return;
        
        const elapsed = Date.now() - this.startTime;
        const hours = Math.floor(elapsed / 3600000);
        const minutes = Math.floor((elapsed % 3600000) / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        
        const timerDisplay = document.getElementById('testTimer');
        if (timerDisplay) {
            timerDisplay.textContent = 
                `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }
    

    cleanupUrlObjects() {
        this.urlObjectsToCleanup.forEach(url => {
            try {
                URL.revokeObjectURL(url);
            } catch (error) {
                console.warn('清理URL对象失败:', error);
            }
        });
        this.urlObjectsToCleanup.clear();
    }

    getCurrentSessionRecords() {
        if (!this.currentSession) return [];
        return this.testData.filter(record => record.sessionId === this.currentSession.id);
    }

    saveSessionData() {
        try {
            localStorage.setItem('roadTestSessions', JSON.stringify(this.testSessions));
        } catch (error) {
            console.error('保存会话数据失败:', error);
        }
    }

    loadSessionData() {
        try {
            const savedSessions = localStorage.getItem('roadTestSessions');
            if (savedSessions) {
                this.testSessions = JSON.parse(savedSessions);
            }
        } catch (error) {
            console.error('加载会话数据失败:', error);
            this.testSessions = [];
        }
    }

    cleanup() {
        if (this.displayTimer) {
            clearTimeout(this.displayTimer);
            this.displayTimer = null;
        }
        
        this.cleanupUrlObjects();
        this.stopTimer();
        
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch (error) {
                console.warn('停止语音识别失败:', error);
            }
        }
    }

    handleQuickRecord(type) {
        if (!this.currentSession) {
            // 如果没有活动会话，先开始测试
            this.startTest();
        }
        
        let typeText = '';
        switch(type) {
            case 'safety':
                typeText = '安全接管';
                break;
            case 'efficiency':
                typeText = '效率接管';
                break;
            case 'experience':
                typeText = '体验问题';
                break;
        }
        
        this.addRecord(typeText, '手动记录', `快速记录：${typeText}`);
    }

    exportData() {
        if (this.testData.length === 0) {
            alert('没有数据可以导出');
            return;
        }

        const csvContent = this.generateCSV();
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        
        if (link.download !== undefined) {
            const url = URL.createObjectURL(blob);
            this.urlObjectsToCleanup.add(url);
            
            link.setAttribute('href', url);
            link.setAttribute('download', `道路测试记录_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            // 延迟清理URL对象
            setTimeout(() => {
                try {
                    URL.revokeObjectURL(url);
                    this.urlObjectsToCleanup.delete(url);
                } catch (error) {
                    console.warn('清理URL对象失败:', error);
                }
            }, 1000);
        }
    }

    generateCurrentSessionCSV() {
        const currentRecords = this.getCurrentSessionRecords();
        const headers = ['测试名称', '时间戳', '类型', '子类型', '原始语音'];
        const rows = [headers.join(',')];

        currentRecords.forEach(record => {
            const row = [
                `"${record.sessionName || '当前测试'}"`,
                `"${new Date(record.timestamp).toLocaleString('zh-CN')}"`,
                `"${record.type}"`,
                `"${record.subType}"`,
                `"${record.originalText}"`
            ];
            rows.push(row.join(','));
        });

        return '\uFEFF' + rows.join('\n');
    }

    generateAllDataCSV() {
        const headers = ['测试名称', '时间戳', '类型', '子类型', '原始语音', '会话ID'];
        const rows = [headers.join(',')];

        // 按测试会话分组排序
        this.testData.sort((a, b) => {
            const sessionA = this.testSessions.find(s => s.id === a.sessionId);
            const sessionB = this.testSessions.find(s => s.id === b.sessionId);
            const timeA = sessionA ? new Date(sessionA.startTime) : new Date(a.timestamp);
            const timeB = sessionB ? new Date(sessionB.startTime) : new Date(b.timestamp);
            return timeB - timeA; // 新的在前
        });

        this.testData.forEach(record => {
            const row = [
                `"${record.sessionName || '未知测试'}"`,
                `"${new Date(record.timestamp).toLocaleString('zh-CN')}"`,
                `"${record.type}"`,
                `"${record.subType}"`,
                `"${record.originalText}"`,
                `"${record.sessionId}"`
            ];
            rows.push(row.join(','));
        });

        return '\uFEFF' + rows.join('\n');
    }


    loadApiKey() {
        try {
            const savedApiKey = localStorage.getItem('aliCloudApiKey');
            if (savedApiKey) {
                this.aliCloudConfig.apiKey = savedApiKey;
            }
        } catch (error) {
            console.error('加载API Key失败:', error);
        }
    }


    loadData() {
        try {
            const savedData = localStorage.getItem('roadTestData');
            if (savedData) {
                this.testData = JSON.parse(savedData);
            }
        } catch (error) {
            console.error('加载数据失败:', error);
            this.testData = [];
        }
    }

    saveData() {
        try {
            localStorage.setItem('roadTestData', JSON.stringify(this.testData));
        } catch (error) {
            console.error('保存数据失败:', error);
        }
    }

    updateUI() {
        // 更新录制状态
        const startBtn = document.getElementById('startTestBtn');
        const pauseBtn = document.getElementById('pauseTestBtn');
        const stopBtn = document.getElementById('stopTestBtn');
        const statusIndicator = document.getElementById('statusIndicator');
        const currentStatus = document.getElementById('currentStatus');
        
        if (this.isRecording) {
            // 显示暂停和停止按钮，隐藏开始按钮
            if (startBtn) startBtn.style.display = 'none';
            if (pauseBtn) pauseBtn.style.display = 'flex';
            if (stopBtn) stopBtn.style.display = 'flex';
            
            if (statusIndicator) {
                statusIndicator.textContent = '录制中...';
                statusIndicator.className = 'recording';
            }
            if (currentStatus) {
                const sessionName = this.currentSession?.name || '测试进行中';
                currentStatus.textContent = sessionName;
            }
            
            // 更新语音状态显示
            this.updateVoiceStatus();
        } else {
            // 显示开始按钮，隐藏暂停和停止按钮
            if (startBtn) startBtn.style.display = 'flex';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'none';
            
            if (statusIndicator) {
                statusIndicator.textContent = '未录制';
                statusIndicator.className = 'stopped';
            }
            if (currentStatus) {
                const lastSession = this.testSessions[this.testSessions.length - 1];
                currentStatus.textContent = lastSession ? `上次测试: ${lastSession.name}` : '未开始';
            }
            
            // 更新语音状态显示
            this.updateVoiceStatus();
        }

        // 更新统计数据
        this.updateStatistics();
        
        // 更新最近记录
        this.updateRecentRecords();
        
        // 更新快速记录计数
        this.updateQuickRecordCounts();
        
        // 更新测试历史
        this.updateTestHistory();
    }

    updateStatistics() {
        const stats = this.calculateStatistics();
        
        const totalCount = document.getElementById('totalCount');
        if (totalCount) totalCount.textContent = stats.total;
    }
    
    updateQuickRecordCounts() {
        const stats = this.calculateStatistics();
        
        const safetyCount = document.getElementById('safetyCount');
        const efficiencyCount = document.getElementById('efficiencyCount');
        const experienceCount = document.getElementById('experienceCount');
        
        if (safetyCount) safetyCount.textContent = stats.safety;
        if (efficiencyCount) efficiencyCount.textContent = stats.efficiency;
        if (experienceCount) experienceCount.textContent = stats.experience;
    }

    calculateStatistics() {
        // 只统计当前测试周期的数据
        const currentRecords = this.getCurrentSessionRecords();
        const stats = {
            total: currentRecords.length,
            experience: 0,
            safety: 0,
            efficiency: 0
        };

        currentRecords.forEach(record => {
            switch (record.type) {
                case '体验问题':
                    stats.experience++;
                    break;
                case '安全接管':
                    stats.safety++;
                    break;
                case '效率接管':
                    stats.efficiency++;
                    break;
            }
        });

        return stats;
    }

    getTypeClass(type) {
        const typeMapping = {
            '安全接管': 'type-safety-takeover',
            '效率接管': 'type-efficiency-takeover', 
            '体验问题': 'type-experience-issue'
        };
        return typeMapping[type] || `type-${type}`;
    }

    updateRecentRecords() {
        const container = document.getElementById('recentRecords');
        if (!container) return;
        
        // 只显示当前测试周期的最近记录
        const currentRecords = this.getCurrentSessionRecords();
        const recentData = currentRecords.slice(-5).reverse();
        
        // 性能优化：只有数据变化时才重新渲染
        if (JSON.stringify(this.lastRecentData) === JSON.stringify(recentData)) {
            return;
        }
        this.lastRecentData = [...recentData];

        container.innerHTML = '';

        if (recentData.length === 0) {
            container.innerHTML = '<div class="no-records">暂无记录</div>';
            return;
        }

        recentData.forEach(record => {
            const recordElement = document.createElement('div');
            recordElement.className = 'record-item';
            
            // 转换类名为英文
            const typeClass = this.getTypeClass(record.type);
            
            recordElement.innerHTML = `
                <div class="record-header">
                    <span class="record-type ${typeClass}">${record.type}</span>
                    <span class="record-time">${new Date(record.timestamp).toLocaleTimeString('zh-CN')}</span>
                </div>
                <div class="record-content">
                    <div class="record-subtype">${record.subType}</div>
                    <div class="record-text">${record.originalText}</div>
                </div>
            `;
            container.appendChild(recordElement);
        });
    }

    updateTestHistory() {
        const container = document.getElementById('historyList');
        if (!container) return;

        if (this.testSessions.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>暂无历史测试</p><small>完成测试后将显示历史记录</small></div>';
            return;
        }

        // 按时间倒序显示
        const sortedSessions = [...this.testSessions].reverse();
        
        container.innerHTML = '';
        
        // 添加事件委托处理历史记录操作
        container.removeEventListener('click', this.handleHistoryActions);
        this.handleHistoryActions = (e) => {
            const target = e.target;
            console.log('🔍 历史记录点击事件:', { target, classes: target.classList.value });
            
            if (target.classList.contains('btn-mini')) {
                const action = target.getAttribute('data-action');
                const sessionId = target.getAttribute('data-session-id');
                
                console.log('🎯 检测到按钮点击:', { action, sessionId, sessionIdType: typeof sessionId });
                
                if (action === 'export') {
                    console.log('📤 开始导出会话:', sessionId);
                    try {
                        this.exportSession(sessionId);
                    } catch (error) {
                        console.error('❌ 导出失败:', error);
                        alert('导出失败: ' + error.message);
                    }
                } else if (action === 'delete') {
                    console.log('🗑️ 开始删除会话:', sessionId);
                    try {
                        this.deleteSession(sessionId);
                    } catch (error) {
                        console.error('❌ 删除失败:', error);
                        alert('删除失败: ' + error.message);
                    }
                }
            }
        };
        container.addEventListener('click', this.handleHistoryActions);
        
        sortedSessions.forEach(session => {
            const historyElement = document.createElement('div');
            historyElement.className = 'history-item';
            
            const duration = this.calculateSessionDuration(session);
            const sessionStats = this.getSessionStatistics(session.id);
            
            historyElement.innerHTML = `
                <div class="history-header">
                    <span class="history-name">${session.name}</span>
                    <span class="history-time">${duration}</span>
                </div>
                <div class="history-stats">
                    <span class="stat">总计: ${session.recordCount || 0}</span>
                    <span class="stat safety">安全: ${sessionStats.safety}</span>
                    <span class="stat efficiency">效率: ${sessionStats.efficiency}</span>
                    <span class="stat experience">体验: ${sessionStats.experience}</span>
                </div>
                <div class="history-actions">
                    <button class="btn-mini" data-action="export" data-session-id="${session.id}">导出</button>
                    <button class="btn-mini btn-danger" data-action="delete" data-session-id="${session.id}">删除</button>
                </div>
            `;
            container.appendChild(historyElement);
        });
    }

    calculateSessionDuration(session) {
        if (!session.endTime) return '进行中';
        
        const start = new Date(session.startTime);
        const end = new Date(session.endTime);
        const diff = end - start;
        
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    getSessionStatistics(sessionId) {
        const sessionRecords = this.testData.filter(record => record.sessionId === sessionId);
        const stats = { safety: 0, efficiency: 0, experience: 0 };
        
        sessionRecords.forEach(record => {
            switch (record.type) {
                case '体验问题': stats.experience++; break;
                case '安全接管': stats.safety++; break;
                case '效率接管': stats.efficiency++; break;
            }
        });
        
        return stats;
    }

    toggleTestHistory() {
        const historyList = document.getElementById('historyList');
        const toggleBtn = document.getElementById('historyToggleBtn');
        
        // 检查当前显示状态 - 默认是展开的
        const isVisible = historyList.style.display !== 'none';
        
        if (isVisible) {
            historyList.style.display = 'none';
            toggleBtn.textContent = '展开';
        } else {
            historyList.style.display = 'block';
            toggleBtn.textContent = '收起';
            this.updateTestHistory();
        }
    }

    exportSession(sessionId) {
        console.log('🚀 exportSession 调用:', { sessionId, type: typeof sessionId });
        console.log('📊 当前会话列表:', this.testSessions.map(s => ({ id: s.id, name: s.name, idType: typeof s.id })));
        
        // 处理字符串和数字类型的 sessionId
        const numericSessionId = Number(sessionId);
        const stringSessionId = String(sessionId);
        
        const session = this.testSessions.find(s => 
            s.id === sessionId || 
            s.id === numericSessionId || 
            s.id === stringSessionId
        );
        
        console.log('🎯 找到的会话:', session);
        
        if (!session) {
            console.error('❌ 未找到会话:', { sessionId, available: this.testSessions.map(s => s.id) });
            alert('未找到指定的测试记录');
            return;
        }
        
        const sessionRecords = this.testData.filter(record => 
            record.sessionId === sessionId || 
            record.sessionId === numericSessionId || 
            record.sessionId === stringSessionId
        );
        
        console.log('📝 找到的记录:', sessionRecords.length, sessionRecords);
        
        if (sessionRecords.length === 0) {
            alert('该测试没有记录数据');
            return;
        }

        try {
            const csvContent = this.generateSessionCSV(sessionRecords, session);
            console.log('📄 生成的CSV内容长度:', csvContent.length);
            
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            
            if (link.download !== undefined) {
                const url = URL.createObjectURL(blob);
                this.urlObjectsToCleanup.add(url);
                
                link.setAttribute('href', url);
                link.setAttribute('download', `${session.name}.csv`);
                link.style.visibility = 'hidden';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                console.log('✅ 导出成功:', session.name);
                
                setTimeout(() => {
                    try {
                        URL.revokeObjectURL(url);
                        this.urlObjectsToCleanup.delete(url);
                    } catch (error) {
                        console.warn('清理URL对象失败:', error);
                    }
                }, 1000);
            } else {
                console.error('❌ 浏览器不支持下载功能');
                alert('浏览器不支持文件下载功能');
            }
        } catch (error) {
            console.error('❌ 导出过程出错:', error);
            alert('导出失败: ' + error.message);
        }
    }

    deleteSession(sessionId) {
        if (!confirm('确定要删除这个测试记录吗？此操作不可恢复。')) return;
        
        // 删除会话记录
        this.testSessions = this.testSessions.filter(s => s.id !== sessionId);
        
        // 删除相关的测试数据
        this.testData = this.testData.filter(record => record.sessionId !== sessionId);
        
        // 保存数据
        this.saveData();
        this.saveSessionData();
        
        // 更新UI
        this.updateUI();
        this.showNotification('测试记录已删除');
    }

    generateSessionCSV(records, session) {
        const headers = ['测试名称', '时间戳', '类型', '子类型', '原始语音'];
        const rows = [headers.join(',')];

        records.forEach(record => {
            const row = [
                `"${session.name}"`,
                `"${new Date(record.timestamp).toLocaleString('zh-CN')}"`,
                `"${record.type}"`,
                `"${record.subType}"`,
                `"${record.originalText}"`
            ];
            rows.push(row.join(','));
        });

        return '\uFEFF' + rows.join('\n');
    }

    updateRecognitionDisplay(text) {
        const display = document.getElementById('recognitionDisplay');
        const statusText = document.getElementById('voiceStatusText');
        
        if (display) {
            display.textContent = `识别中: ${text}`;
        }
        
        if (statusText) {
            statusText.textContent = '识别中...';
        }
        
        // 清除之前的定时器
        if (this.displayTimer) {
            clearTimeout(this.displayTimer);
        }
        
        // 3秒后恢复显示
        this.displayTimer = setTimeout(() => {
            if (display) display.textContent = '等待语音输入...';
            if (statusText) statusText.textContent = this.isRecording ? '语音激活' : '语音待机';
        }, 3000);
    }


    updateVoiceStatus() {
        const voiceDot = document.getElementById('voiceDot');
        const voiceStatusText = document.getElementById('voiceStatusText');
        
        if (voiceDot && voiceStatusText) {
            if (this.isRecording) {
                voiceDot.className = 'voice-dot active';
                voiceStatusText.textContent = '语音激活';
            } else {
                voiceDot.className = 'voice-dot';
                voiceStatusText.textContent = '语音待机';
            }
        }
    }

    showDebugInfo(message) {
        const display = document.getElementById('recognitionDisplay');
        if (display) {
            display.textContent = message;
            display.style.color = message.includes('⚠️') ? '#e53e3e' : '#4299e1';
        }
        
        // 5秒后清除调试信息
        if (this.debugTimer) {
            clearTimeout(this.debugTimer);
        }
        this.debugTimer = setTimeout(() => {
            if (display) {
                display.textContent = '等待语音输入...';
                display.style.color = '#718096';
            }
        }, 5000);
    }

    showNotification(message) {
        const notification = document.getElementById('notification');
        notification.textContent = message;
        notification.style.display = 'block';
        
        setTimeout(() => {
            notification.style.display = 'none';
        }, 3000);
    }

    showRecordNotification(record) {
        this.showNotification(`已记录: ${record.type} - ${record.subType}`);
    }

    showDeleteNotification(record) {
        this.showNotification(`已删除: ${record.type} - ${record.subType}`);
    }


    bindEvents() {
        // 等待DOM加载完成
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setupEventListeners());
        } else {
            this.setupEventListeners();
        }
    }
    
    setupEventListeners() {
        console.log('🔗 设置事件监听器...');
        // 主要控制按钮
        const startBtn = document.getElementById('startTestBtn');
        const pauseBtn = document.getElementById('pauseTestBtn');
        const stopBtn = document.getElementById('stopTestBtn');
        
        console.log('🎯 按钮元素检查:', {
            startBtn: !!startBtn,
            pauseBtn: !!pauseBtn,
            stopBtn: !!stopBtn
        });
        
        if (startBtn) {
            console.log('✅ 绑定开始测试按钮事件');
            startBtn.addEventListener('click', () => {
                console.log('🖱️ 开始测试按钮被点击');
                this.startTest();
            });
        } else {
            console.error('❌ 找不到开始测试按钮元素');
        }
        
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => this.pauseTest());
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopTest());
        }
        
        // 快速记录按钮
        const problemBtns = document.querySelectorAll('.problem-btn');
        problemBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = e.currentTarget.dataset.type;
                this.handleQuickRecord(type);
            });
        });
        
        // 测试记录管理按钮
        const exportCurrentBtn = document.getElementById('exportCurrentBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const historyToggleBtn = document.getElementById('historyToggleBtn');

        if (exportCurrentBtn) {
            exportCurrentBtn.addEventListener('click', () => this.exportData());
        }
        
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.updateRecentRecords());
        }

        if (historyToggleBtn) {
            historyToggleBtn.addEventListener('click', () => this.toggleTestHistory());
        }

        // 防止页面意外关闭
        window.addEventListener('beforeunload', (e) => {
            if (this.isRecording) {
                e.preventDefault();
                return '测试正在进行中，确定要离开吗？';
            }
        });

        // 页面获得焦点时重启语音识别
        window.addEventListener('focus', () => {
            if (this.isRecording && this.recognition && this.state === RoadTestRecorder.STATES.RECORDING) {
                this.startSpeechRecognition();
            }
        });
        
        // 页面即将关闭时清理资源
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    // 显示配置模态框
    showConfigModal() {
        // 检查是否已有配置
        const savedConfig = this.loadConfigFromStorage();
        if (savedConfig) {
            this.aliyunConfig.accessKeyId = savedConfig.accessKeyId;
            this.aliyunConfig.accessKeySecret = savedConfig.accessKeySecret;
            this.aliyunConfig.appKey = savedConfig.appKey;
            console.log('✅ 从本地存储加载配置成功');
            setTimeout(() => {
                this.initWebSocketConnection();
            }, 1000);
            return;
        }

        // 显示配置输入界面
        this.showNotification('请配置阿里云语音识别API凭证后使用', 5000);
        
        // 创建配置表单
        const configHtml = `
            <div class="config-modal" id="configModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 2000;">
                <div class="modal-content" style="background: white; padding: 30px; border-radius: 16px; max-width: 400px; width: 90%;">
                    <h3>阿里云API配置</h3>
                    <p>请输入您的阿里云智能语音交互API凭证：</p>
                    
                    <div class="config-form" style="margin: 20px 0;">
                        <label style="display: block; margin: 10px 0 5px 0; font-weight: 600;">AccessKey ID:</label>
                        <input type="text" id="accessKeyId" placeholder="请输入AccessKey ID" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 15px;" />
                        
                        <label style="display: block; margin: 10px 0 5px 0; font-weight: 600;">AccessKey Secret:</label>
                        <input type="password" id="accessKeySecret" placeholder="请输入AccessKey Secret" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 15px;" />
                        
                        <label style="display: block; margin: 10px 0 5px 0; font-weight: 600;">App Key:</label>
                        <input type="text" id="appKey" placeholder="请输入App Key" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 20px;" />
                        
                        <div class="config-actions" style="display: flex; gap: 10px; justify-content: center;">
                            <button onclick="recorder.saveConfig()" style="padding: 10px 20px; background: #4299e1; color: white; border: none; border-radius: 6px; cursor: pointer;">保存配置</button>
                            <button onclick="window.open('https://help.aliyun.com/zh/isi', '_blank')" style="padding: 10px 20px; background: #48bb78; color: white; border: none; border-radius: 6px; cursor: pointer;">获取API凭证</button>
                        </div>
                    </div>
                    
                    <div class="config-notice" style="text-align: center; margin-top: 15px;">
                        <small style="color: #718096;">💡 配置将保存在浏览器本地，不会上传到服务器</small>
                    </div>
                </div>
            </div>
        `;
        
        // 添加到页面
        document.body.insertAdjacentHTML('beforeend', configHtml);
    }

    // 保存配置
    saveConfig() {
        const accessKeyId = document.getElementById('accessKeyId').value.trim();
        const accessKeySecret = document.getElementById('accessKeySecret').value.trim();
        const appKey = document.getElementById('appKey').value.trim();
        
        if (!accessKeyId || !accessKeySecret || !appKey) {
            this.showNotification('请填写完整的API配置信息', 3000);
            return;
        }
        
        // 保存到本地存储
        const config = { accessKeyId, accessKeySecret, appKey };
        localStorage.setItem('aliyun_voice_config', JSON.stringify(config));
        
        // 应用配置
        this.aliyunConfig.accessKeyId = accessKeyId;
        this.aliyunConfig.accessKeySecret = accessKeySecret;
        this.aliyunConfig.appKey = appKey;
        
        // 移除配置界面
        const modal = document.getElementById('configModal');
        if (modal) {
            modal.remove();
        }
        
        this.showNotification('✅ 配置已保存，正在连接...', 2000);
        
        // 初始化连接
        setTimeout(() => {
            this.initWebSocketConnection();
        }, 1000);
    }

    // 从本地存储加载配置
    loadConfigFromStorage() {
        try {
            const configStr = localStorage.getItem('aliyun_voice_config');
            if (configStr) {
                return JSON.parse(configStr);
            }
        } catch (error) {
            console.warn('加载本地配置失败:', error);
        }
        return null;
    }

    // 清除配置
    clearConfig() {
        localStorage.removeItem('aliyun_voice_config');
        this.aliyunConfig.accessKeyId = '';
        this.aliyunConfig.accessKeySecret = '';
        this.aliyunConfig.appKey = '';
        this.showNotification('配置已清除', 2000);
    }
}

// 初始化应用
let recorder;

document.addEventListener('DOMContentLoaded', () => {
    recorder = new RoadTestRecorder();
});

// 全局函数供HTML调用
window.startTest = () => {
    if (recorder && typeof recorder.startTest === 'function') {
        recorder.startTest();
    }
};
window.resetState = () => {
    if (recorder && typeof recorder.resetState === 'function') {
        recorder.resetState();
    }
};
window.stopTest = () => {
    if (recorder && typeof recorder.stopTest === 'function') {
        recorder.stopTest();
    }
};
window.exportData = () => {
    if (recorder && typeof recorder.exportData === 'function') {
        recorder.exportData();
    }
};
window.setAliyunConfig = (accessKeyId, accessKeySecret, appKey, wsUrl) => {
    if (recorder && typeof recorder.setAliyunConfig === 'function') {
        recorder.setAliyunConfig(accessKeyId, accessKeySecret, appKey, wsUrl);
    }
};
