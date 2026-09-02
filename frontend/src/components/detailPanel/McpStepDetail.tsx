import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExecutionStep, MCPScanResult, MCPVulnerabilityResult, MCPReportItem, PromptBankCase } from '../../types';
import { 
  Clock, 
  CheckCircle, 
  XCircle, 
  Play,
  Calendar,
  Timer,
  Info,
  AlertTriangle,
  FileText,
  BookOpen,
  Shield,
  ShieldCheck,
  Maximize,
  Minimize,
  Share2,
  Download,
  Zap
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '../ui/tooltip';
import { useApp } from '../../context/AppContext';
import CodeHighlight from './CodeHighlight';
import { useReportPrint } from './useReportPrint';

interface McpStepDetailProps {
  step: ExecutionStep | null;
  stepIndex?: number;
  mcpResult?: MCPScanResult;
  selectedTool?: {
    step: ExecutionStep;
    subStepIndex: number;
    toolIndex: number;
  } | null;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  hideFullscreenButton?: boolean;
  sessionId?: string;
  taskType?: string;
}

const McpStepDetail: React.FC<McpStepDetailProps> = ({ 
  step, 
  stepIndex, 
  mcpResult, 
  selectedTool,
  isFullscreen = false, 
  onToggleFullscreen,
  hideFullscreenButton = false,
  sessionId: propSessionId,
  taskType
}) => {
  const { t } = useTranslation();
  const { state } = useApp();

  // This component is shared by SKILL and MCP scans; title/description switch dynamically based on taskType
  const isSkillScan = taskType === 'Skill-Scan';
  const scanResultText = isSkillScan ? t('mcp.scanResultSkill') : t('mcp.scanResult');
  const titleText = isSkillScan ? t('mcp.titleSkill') : t('mcp.title');
  const noRisksDescriptionText = isSkillScan ? t('mcp.noRisksDescriptionSkill') : t('mcp.noRisksDescription');

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const currentTask = state.tasks.find(
    task => task.id === state.currentTaskId,
  );
  const sessionId = propSessionId || currentTask?.id;

  const handleShare = () => {
    if (sessionId) {
      const shareUrl = `${window.location.origin}/report/${sessionId}`;
      window.open(shareUrl, '_blank');
    }
  };

  const handleDownloadPdf = useReportPrint(
    panelRef,
    `A.I.G ${scanResultText}`
  );

  // Handle scroll events and detect whether the user scrolled manually
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10; // 10px tolerance
    setShouldAutoScroll(isAtBottom);
  };

  // Auto-scroll to the bottom
  const scrollToBottom = () => {
    if (scrollContainerRef.current && shouldAutoScroll) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  };

  // Watch actionLog changes and auto-scroll
  useEffect(() => {
    if (step?.subSteps) {
      const hasActionLogChanges = step.subSteps.some(subStep => 
        subStep.toolUsed?.some(tool => tool.actionLog)
      );
      if (hasActionLogChanges) {
        // Use setTimeout to scroll only after the DOM update is complete
        setTimeout(scrollToBottom, 100);
      }
    }
  }, [step?.subSteps, shouldAutoScroll]);

  const [activeTab, setActiveTab] = useState('results');
  const [promptBankCases, setPromptBankCases] = useState<PromptBankCase[]>([]);
  const [promptBankLoading, setPromptBankLoading] = useState(false);
  const [promptBankError, setPromptBankError] = useState('');

  const downloadPromptBankFile = async (fileUrl: string, fallbackFilename: string) => {
    if (!sessionId) {
      setPromptBankError('无法下载：任务 ID 不存在');
      return;
    }
    setPromptBankError('');
    try {
      const response = await fetch(`/api/v1/app/tasks/${sessionId}/downloadFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl }),
      });
      if (!response.ok) {
        let message = '文件下载失败';
        try {
          const payload = await response.json();
          message = payload.message || message;
        } catch {
          // The download endpoint may return a non-JSON proxy error.
        }
        throw new Error(message);
      }

      const disposition = response.headers.get('Content-Disposition');
      const utf8Filename = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const plainFilename = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
      const filename = decodeURIComponent(utf8Filename || plainFilename || fallbackFilename);
      const blobUrl = window.URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      setPromptBankError(error instanceof Error ? error.message : '文件下载失败');
    }
  };

  useEffect(() => {
    if (!isSkillScan || !sessionId || !mcpResult?.prompt_bank ||
        !['completed', 'completed_with_errors'].includes(mcpResult.prompt_bank.status || '')) {
      setPromptBankCases([]);
      return;
    }
    let cancelled = false;
    setPromptBankLoading(true);
    setPromptBankError('');
    fetch(`/api/v1/app/tasks/${sessionId}/prompt-bank`)
      .then(response => response.json())
      .then(payload => {
        if (cancelled) return;
        if (payload.status !== 0) throw new Error(payload.message || '题库加载失败');
        setPromptBankCases(payload.data?.cases || []);
      })
      .catch(error => {
        if (!cancelled) setPromptBankError(error instanceof Error ? error.message : '题库加载失败');
      })
      .finally(() => {
        if (!cancelled) setPromptBankLoading(false);
      });
    return () => { cancelled = true; };
  }, [isSkillScan, sessionId, mcpResult?.prompt_bank?.status, mcpResult?.prompt_bank?.valid_case_count]);

  if (!step && !mcpResult) {
    return (
      <TooltipProvider>
        <div className={`min-w-[320px] bg-white border-l border-gray-200 flex items-center justify-center h-full ${
          isFullscreen 
            ? 'w-full max-w-[1500px] mx-auto' 
            : 'w-full'
        }`}>
          <div className="text-center text-gray-500 p-6">
            <Info className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <h3 className="font-medium mb-2">{t('infraScan.selectStep')}</h3>
            <p className="text-sm">{t('infraScan.selectStepDescription')}</p>
          </div>
        </div>
      </TooltipProvider>
    );
  }

  const getStatusIcon = (status: ExecutionStep['status']) => {
    switch (status) {
      case 'todo':
        return <Clock className="w-5 h-5 text-amber-500" />;
      case 'doing':
        return <Play className="w-5 h-5 text-blue-500 animate-pulse" />;
      case 'done':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: ExecutionStep['status']) => {
    const variants = {
      todo: 'secondary',
      doing: 'default',
      done: 'default',
    } as const;

    const labels = {
      todo: t('mcp.status.todo'),
      doing: t('mcp.status.doing'),
      done: t('mcp.status.done'),
    };

    return (
      <Badge variant={variants[status]} className="text-xs">
        {labels[status]}
      </Badge>
    );
  };

  const formatTime = (date?: Date | string) => {
    if (!date) return '-';
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(dateObj);
  };

  const formatDuration = (start?: Date | string, end?: Date | string) => {
    if (!start) return '-';
    const startObj = typeof start === 'string' ? new Date(start) : start;
    const endObj = end ? (typeof end === 'string' ? new Date(end) : end) : new Date();
    const duration = Math.round((endObj.getTime() - startObj.getTime()) / 1000);
    
    if (duration < 60) return `${duration}${t('infraScan.timeUnits.seconds')}`;
    if (duration < 3600) return `${Math.round(duration / 60)}${t('infraScan.timeUnits.minutes')}`;
    return `${Math.round(duration / 3600)}${t('infraScan.timeUnits.hours')}`;
  };

  const formatSecondsDuration = (start?: number, end?: number) => {
    if (!start || !end) return '-';
    const duration = end - start;
    if (duration < 60) return `${duration}${t('infraScan.timeUnits.seconds')}`;
    if (duration < 3600) return `${Math.round(duration / 60)}${t('infraScan.timeUnits.minutes')}`;
    return `${Math.round(duration / 3600)}${t('infraScan.timeUnits.hours')}`;
  };

  const getLevelColor = (level?: string) => {
    switch (level?.toLowerCase() || '') {
      case 'high':
      case 'critical':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low':
        return 'bg-green-100 text-green-800 border-green-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const renderVulnerabilityResult = (result: MCPVulnerabilityResult, index: number) => (
    <Card key={index} className="mb-4 w-full rounded-2xl overflow-hidden shadow-lg border border-gray-100 p-2">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="text-sm flex items-center min-w-0">
            <AlertTriangle className="w-4 h-4 mr-2 text-red-500 flex-shrink-0" />
            <span className="truncate">{result.title}</span>
          </CardTitle>
          <Badge className={`text-xs flex-shrink-0 ${getLevelColor(result.level)}`}>
            {result.level}
          </Badge>
        </div>
        {result.pluginId && (
          <div className="text-xs text-gray-500 truncate">
            {t('mcp.pluginId')}: {result.pluginId}
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0 space-y-3 w-full">
        <div>
          <div className="text-sm font-medium text-gray-700 my-2 flex items-center">
            <FileText className="w-4 h-4 mr-1 text-gray-500 flex-shrink-0" />
            {t('mcp.vulnerabilityDescription')}
          </div>
          <div className="text-sm text-gray-600 prose prose-sm max-w-none w-full">
            <CodeHighlight>
              {result.description}
            </CodeHighlight>
          </div>
        </div>
        <Separator />
        <div>
          <div className="text-sm font-medium text-gray-700 mb-2 flex items-center">
            <ShieldCheck className="w-4 h-4 mr-1 text-gray-500 flex-shrink-0" />
            {t('mcp.fixSuggestion')}
          </div>
          <div className="text-sm text-gray-600 w-full">
            <CodeHighlight>
              {result.suggestion}
            </CodeHighlight>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderReportItem = (item: MCPReportItem, index: number) => (
    <Card key={index} className="mb-3 w-full rounded-2xl overflow-hidden shadow-lg border border-gray-100 p-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center min-w-0">
          <Info className="w-4 h-4 mr-2 text-blue-500 flex-shrink-0" />
          <span className="truncate">{item.title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 w-full">
        <div className="text-sm text-gray-600 w-full">
          <CodeHighlight>
            {item.description}
          </CodeHighlight>
        </div>
      </CardContent>
    </Card>
  );

  // If only mcpResult is present, show the scan results
  if (mcpResult && !step) {
    return (
      <TooltipProvider>
        <div 
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="bg-gray-50 border-l border-gray-200 w-full h-full transition-all duration-300 ease-in-out overflow-y-auto scrollbar-hover print-content-wrapper"
        >
          {/* Header */}
          <div className="p-4 border-b border-gray-200 w-full bg-white sticky top-0 z-10">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShieldCheck className="w-5 h-5 text-blue-500" />
                <span className="text-sm font-medium text-gray-500">
                  {titleText}
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleDownloadPdf}
                      className="p-1.5 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
                    >
                      <Download className="w-4 h-4 text-gray-500" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('redteam.downloadDetailedReport')}</p>
                  </TooltipContent>
                </Tooltip>
                {sessionId && !hideFullscreenButton && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleShare}
                        className="p-1.5 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
                      >
                        <Share2 className="w-4 h-4 text-gray-500" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('infraScan.share')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                {onToggleFullscreen && !hideFullscreenButton && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('全屏按钮被点击，当前状态:', isFullscreen);
                          onToggleFullscreen();
                        }}
                        className="p-1.5 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
                      >
                        {isFullscreen ? (
                          <Minimize className="w-4 h-4 text-gray-500" />
                        ) : (
                          <Maximize className="w-4 h-4 text-gray-500" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{isFullscreen ? t('infraScan.exitFullscreen') : t('infraScan.fullscreen')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
          <div ref={panelRef} className={`w-full ${isFullscreen ? 'max-w-[1200px] w-full mx-auto' : ''}`}>
            <div className={`flex flex-col w-full pb-10 bg-white ${
              isFullscreen ? 'mt-10' : 'mt-4'
            }`}>
            <div className='relative overflow-hidden rounded-t-2xl mb-6 w-full' style={{
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              padding: '40px 40px 60px 40px',
              textAlign: 'center',
              color: 'white',
            }}>
              <div className='absolute top-[-50%] left-[-50%] w-[200%] h-[200%] opacity-30' style={{
                background: 'radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%)',
                animation: 'pulse 6s ease-in-out infinite'
              }}></div>
              <h1 className='text-xl sm:text-2xl md:text-3xl font-bold flex items-center justify-center w-full overflow-hidden'>
                <img src="/images/logo-white.png" alt="A.I.G" className="w-6 h-6 sm:w-8 sm:h-8 mr-2 flex-shrink-0" />
                <span className="truncate" style={{ letterSpacing: '0.1em' }}><span className="text-md mr-4 relative" style={{ fontFamily: 'tencentSans', letterSpacing: '0.1em', top: '-2px' }}>A.I.G</span> {scanResultText}</span>
              </h1>
              {mcpResult.target && (
                <p className='opacity-90 relative z-10 truncate w-full text-sm sm:text-base mt-2 sm:mt-4' style={{ fontWeight: '700' }}>
                  {mcpResult.target}
                </p>
              )}
              <div className="absolute bottom-6 left-0 w-full z-10 flex flex-col items-center justify-center gap-1 text-sm opacity-90 sm:flex-row sm:gap-4">
                {mcpResult.llm && (
                  <span className="flex items-center">
                    <Zap className="w-4 h-4 mr-1" />
                    {t('mcp.modelUsed')}: {mcpResult.llm}
                  </span>
                )}
                {mcpResult.start_time && mcpResult.end_time && (
                  <span className="flex items-center">
                    <Clock className="w-4 h-4 mr-1" />
                    {t('mcp.scanDuration')}: {formatSecondsDuration(mcpResult.start_time, mcpResult.end_time)}
                  </span>
                )}
              </div>
            </div>
            <div className={`grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 lg:gap-4 mb-0 mt-6 pb-4 ${
              isFullscreen ? 'px-10 py-2' : 'px-2 sm:px-4'
            }`}>
              <div className='bg-white p-4 sm:p-3 md:p-4 rounded-xl text-center shadow-lg border border-gray-100 transition-all duration-300 hover:transform hover:-translate-y-1 hover:shadow-xl min-w-0'>
                <div className={`text-lg sm:text-xl md:text-2xl font-bold mb-1 sm:mb-2 truncate ${
                  (mcpResult.score || 0) < 60 ? 'text-red-600' : 
                  (mcpResult.score || 0) <= 80 ? 'text-yellow-600' : 'text-green-600'
                }`}>
                  {(mcpResult.score || 0) < 60 ? t('mcp.low') : 
                   (mcpResult.score || 0) <= 80 ? t('mcp.medium') : t('mcp.high')}
                </div>
                <div className='text-sm text-gray-500 truncate'>{t('mcp.securityLevel')}</div>
              </div>
              <div className='bg-white p-2 sm:p-3 md:p-4 rounded-xl text-center shadow-lg border border-gray-100 transition-all duration-300 hover:transform hover:-translate-y-1 hover:shadow-xl min-w-0'>
                <div className={`text-lg sm:text-xl md:text-2xl font-bold mb-1 sm:mb-2 truncate ${
                  (mcpResult.score || 0) < 60 ? 'text-red-600' : 
                  (mcpResult.score || 0) <= 80 ? 'text-yellow-600' : 'text-green-600'
                }`}>
                  {mcpResult.score || 0}
                </div>
                <div className='text-sm text-gray-500 truncate'>{t('mcp.score')}</div>
              </div>
              <div className='bg-white p-2 sm:p-3 md:p-4 rounded-xl text-center shadow-lg border border-gray-100 transition-all duration-300 hover:transform hover:-translate-y-1 hover:shadow-xl min-w-0'>
                <div className={`text-lg sm:text-xl md:text-2xl font-bold mb-1 sm:mb-2 truncate ${
                  (mcpResult.results?.length || 0) === 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {mcpResult.results?.length || 0}
                </div>
                <div className='text-sm text-gray-500 truncate'>{t('mcp.vulnerabilityCount')}</div>
              </div>
              <div className='bg-white p-2 sm:p-3 md:p-4 rounded-xl text-center shadow-lg border border-gray-100 transition-all duration-300 hover:transform hover:-translate-y-1 hover:shadow-xl min-w-0'>
                <div className='text-lg sm:text-xl md:text-2xl font-bold text-blue-600 mb-1 sm:mb-2 truncate'>
                  {mcpResult.language || t('infraScan.target.unknown')}
                </div>
                <div className='text-sm text-gray-500 truncate'>{t('mcp.projectLanguage')}</div>
              </div>
            </div>
          </div>
          <div className='text-lg font-bold text-center p-4 bg-white max-w-[1200px] w-full mx-auto'>
            {t('mcp.reportDetails')}
          </div>
          {/* MCP scan result */}
          <div className={`transition-all duration-300 ease-in-out w-full mb-4`}>
            <div className={`bg-white rounded-b-2xl pb-12 mb-4 ${
              isFullscreen
                ? 'max-w-[1200px] w-full mx-auto'
                : 'w-full'
            }`}>
              {isSkillScan && mcpResult.prompt_bank && (
                <div className="mx-2 sm:mx-4 mb-4 rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="font-medium text-blue-900">Prompt 题库</div>
                      <div className="text-sm text-blue-700">
                        状态：{mcpResult.prompt_bank.status || 'unknown'}，有效题目：{mcpResult.prompt_bank.valid_case_count || 0}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {mcpResult.prompt_bank.file && (
                        <button
                          type="button"
                          onClick={() => downloadPromptBankFile(
                            mcpResult.prompt_bank!.file!,
                            mcpResult.prompt_bank!.filename || 'prompt-bank.jsonl',
                          )}
                          className="inline-flex items-center rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
                        >
                          <Download className="mr-1 h-4 w-4" /> 下载题库
                        </button>
                      )}
                      {mcpResult.prompt_bank.summary_file && (
                        <button
                          type="button"
                          onClick={() => downloadPromptBankFile(
                            mcpResult.prompt_bank!.summary_file!,
                            'prompt-bank-summary.json',
                          )}
                          className="inline-flex items-center rounded-md border border-blue-200 bg-white px-3 py-2 text-sm text-blue-700 hover:bg-blue-100"
                        >
                          下载摘要
                        </button>
                      )}
                    </div>
                  </div>
                  {mcpResult.prompt_bank.error && (
                    <div className="mt-2 text-sm text-red-700">{mcpResult.prompt_bank.error}</div>
                  )}
                </div>
              )}
              {isSkillScan && mcpResult.prompt_bank?.status?.startsWith('completed') && (
                <div className="mx-2 sm:mx-4 mb-4 rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="font-medium text-slate-900">题目内容</div>
                    {promptBankLoading && <span className="text-sm text-slate-500">加载中...</span>}
                  </div>
                  {promptBankError && <div className="text-sm text-red-600">{promptBankError}</div>}
                  {!promptBankLoading && !promptBankError && promptBankCases.length === 0 && (
                    <div className="text-sm text-slate-500">暂无可展示题目</div>
                  )}
                  <div className="space-y-3">
                    {promptBankCases.map((promptCase, index) => (
                      <div key={promptCase.case_id || index} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span>#{index + 1}</span>
                          <Badge variant="secondary">{promptCase.prompt_type}</Badge>
                          {promptCase.vulnerability?.level && <Badge variant="outline">{promptCase.vulnerability.level}</Badge>}
                          {promptCase.evidence?.source_file && (
                            <span>{promptCase.evidence.source_file} {promptCase.evidence.source_lines || ''}</span>
                          )}
                        </div>
                        <div className="whitespace-pre-wrap text-sm text-slate-900">{promptCase.prompt}</div>
                        {promptCase.expected && (
                          <div className="mt-3 rounded-md border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-900">
                            <div><span className="font-medium">预期标签：</span>{promptCase.expected.label || '-'}</div>
                            <div><span className="font-medium">预期行为：</span>{promptCase.expected.behavior || '-'}</div>
                            {promptCase.expected.must_not?.length ? (
                              <div><span className="font-medium">禁止行为：</span>{promptCase.expected.must_not.join('；')}</div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <div className="flex-shrink-0 w-full">
                  <div className={`bg-white w-full ${
                    isFullscreen ? 'px-10 py-2' : 'p-2 sm:p-4'
                  }`}>
                    <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="results" className="flex items-center space-x-1 min-w-0">
                      <Shield className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{t('mcp.securityRisks')}</span>
                      {mcpResult.results && mcpResult.results.length > 0 && (
                        <Badge variant="secondary" className="ml-1 text-xs flex-shrink-0">
                          {mcpResult.results?.length || 0}
                        </Badge>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="readme" className="flex items-center space-x-1 min-w-0">
                      <BookOpen className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{t('mcp.projectOverview')}</span>
                    </TabsTrigger>
                  </TabsList>
                  </div>
                </div>
                <div className="w-full flex flex-col">
                  <TabsContent value="results" className={`space-y-4 bg-white mt-0 w-full ${
                    isFullscreen ? 'px-10 py-6' : 'p-2 sm:p-4'
                  }`}>
                    {(!mcpResult.results || mcpResult.results.length === 0) ? (
                      <div className="text-center text-gray-500 py-12 flex flex-col items-center justify-center">
                        <div className="bg-green-50 p-4 rounded-full mb-4">
                          <ShieldCheck className="w-12 h-12 text-green-500" />
                        </div>
                        <h3 className="text-lg font-medium text-gray-900 mb-1">{t('mcp.noRisksFound')}</h3>
                        <p className="text-sm text-gray-500">{noRisksDescriptionText}</p>
                      </div>
                    ) : (
                      <div>
                        <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                          <div className="flex items-center space-x-2">
                            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
                            <span className="font-medium text-gray-900">{t('mcp.vulnerabilitiesFound', { count: mcpResult.results?.length || 0 })}</span>
                          </div>
                          <div className='text-sm text-gray-400 flex items-center gap-1 min-w-0'>
                            <Info className='w-3 h-3 flex-shrink-0' />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="truncate cursor-help">{t('mcp.verificationNote')}</span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{t('mcp.verificationNote')}</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                        {mcpResult.results?.map((result, index) => 
                          renderVulnerabilityResult(result, index)
                        )}
                      </div>
                    )}
                    {/* Explanations for vulnerabilities that were not detected */}
                    {mcpResult.report && mcpResult.report.length > 0 && (
                      <div className="w-full">
                        <div className="flex items-center space-x-2 mb-3">
                          <Info className="w-5 h-5 text-blue-500 flex-shrink-0" />
                          <span className="font-medium text-gray-900">{t('mcp.other')}</span>
                        </div>
                        {mcpResult.report?.map((item, index) => 
                          renderReportItem(item, index)
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="readme" className={`bg-white mt-0 w-full ${
                    isFullscreen ? 'px-10 py-2' : 'p-2 sm:p-4'
                  }`}>
                    <div className="prose prose-sm max-w-none w-full">
                      <CodeHighlight>
                        {mcpResult.readme || ''}
                      </CodeHighlight>
                    </div>
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          </div>
        </div>
        </div>
      </TooltipProvider>
    );
  }

  // Ensure step exists
  if (!step) {
    return (
      <TooltipProvider>
        <div className="min-w-[320px] bg-white border-l border-gray-200 flex items-center justify-center w-full h-full transition-all duration-300 ease-in-out">
          <div className="text-center text-gray-500 p-6">
            <Info className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <h3 className="font-medium mb-2">{t('infraScan.selectStep')}</h3>
            <p className="text-sm">{t('infraScan.selectStepDescription')}</p>
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
        <div 
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="bg-white border-l border-gray-200 w-full h-full transition-all duration-300 ease-in-out overflow-y-auto scrollbar-hover print-content-wrapper"
        >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 w-full bg-white sticky top-0 z-10">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-2">
              <span className="text-sm font-mono text-gray-500 bg-gray-100 px-2 py-1 rounded">
                {stepIndex !== undefined ? (stepIndex + 1).toString().padStart(2, '0') : '--'}
              </span>
              {getStatusIcon(step.status)}
              <h3 className="font-semibold text-gray-900 text-lg leading-tight">
                {step.title}
              </h3>
              {getStatusBadge(step.status)}
            </div>
            <div className="flex items-center space-x-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleDownloadPdf}
                    className="p-1.5 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
                  >
                    <Download className="w-4 h-4 text-gray-500" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('redteam.downloadDetailedReport')}</p>
                </TooltipContent>
              </Tooltip>
              {sessionId && !hideFullscreenButton && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleShare}
                      className="p-1.5 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
                    >
                      <Share2 className="w-4 h-4 text-gray-500" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('infraScan.share')}</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {onToggleFullscreen && !hideFullscreenButton && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('全屏按钮被点击，当前状态:', isFullscreen);
                        onToggleFullscreen();
                      }}
                      className="p-1.5 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
                    >
                      {isFullscreen ? (
                        <Minimize className="w-4 h-4 text-gray-500" />
                      ) : (
                        <Maximize className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{isFullscreen ? t('infraScan.exitFullscreen') : t('infraScan.fullscreen')}</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>

        {/* Content area */}
        <div ref={panelRef} className="w-full pt-4">
        {/* MCP scan result */}
        {step.mcpResult && (
          <div className={`p-4 border-b border-gray-200 flex-shrink-0 ${
            isFullscreen
              ? 'max-w-[1200px] w-full mx-auto'
              : 'w-full'
          }`}>
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <div className="mb-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="results" className="flex items-center space-x-1 min-w-0">
                    <Shield className="w-4 h-4 flex-shrink-0" />
                    <span className="truncate">安全风险</span>
                    {step.mcpResult.results && step.mcpResult.results.length > 0 && (
                      <Badge variant="secondary" className="ml-1 text-xs flex-shrink-0">
                        {step.mcpResult.results?.length || 0}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="readme" className="flex items-center space-x-1 min-w-0">
                    <BookOpen className="w-4 h-4 flex-shrink-0" />
                    <span className="truncate">项目概览</span>
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="w-full">
                <TabsContent value="results" className="space-y-4">
                  {!step.mcpResult.results || step.mcpResult.results.length === 0 ? (
                    <div className="text-center text-gray-500 py-8 flex flex-col items-center justify-center">
                      <div className="bg-green-50 p-4 rounded-full mb-4">
                        <ShieldCheck className="w-12 h-12 text-green-500" />
                      </div>
                      <h3 className="text-lg font-medium text-gray-900 mb-1">{t('mcp.noRisksFound')}</h3>
                      <p className="text-sm text-gray-500">{noRisksDescriptionText}</p>
                    </div>
                  ) : (
                    <div>
                      <div className="mb-4">
                        <div className="flex items-center space-x-2 mb-2">
                          <AlertTriangle className="w-5 h-5 text-red-500" />
                          <span className="font-medium text-gray-900">{t('mcp.vulnerabilitiesFound', { count: step.mcpResult.results?.length || 0 })}</span>
                        </div>
                      </div>
                      {step.mcpResult.results?.map((result, index) => 
                        renderVulnerabilityResult(result, index)
                      )}
                    </div>
                  )}

                  {/* Explanations for vulnerabilities that were not detected */}
                  {step.mcpResult.report && step.mcpResult.report.length > 0 && (
                    <div className="mt-6">
                      <div className="flex items-center space-x-2 mb-3">
                        <Info className="w-5 h-5 text-blue-500" />
                        <span className="font-medium text-gray-900">{t('mcp.scanDescription')}</span>
                      </div>
                      {step.mcpResult.report?.map((item, index) => 
                        renderReportItem(item, index)
                      )}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="readme" className={isFullscreen ? 'p-10' : 'p-4'}>
                  <div className="prose prose-sm max-w-none">
                    <CodeHighlight>
                      {step.mcpResult.readme || ''}
                    </CodeHighlight>
                  </div>
                </TabsContent>
              </div>
            </Tabs>
          </div>
        )}

        {/* Display tool information */}
        {step.subSteps && step.subSteps.length > 0 && (
          <div className="p-4">
            <div className="space-y-4">
              {(() => {
                const latestPromptBankProgressIndex = step.subSteps.reduce((latestIndex, currentSubStep, currentIndex) => {
                  const isPromptBankStatus = isSkillScan &&
                    currentSubStep.brief?.includes('题库生成') &&
                    !!currentSubStep.description;
                  return isPromptBankStatus ? currentIndex : latestIndex;
                }, -1);

                return step.subSteps.map((subStep, subIndex) => {
                // Check whether any tool in this subStep contains actionLog
                const hasActionLogTools = subStep.toolUsed && subStep.toolUsed.some(tool => 
                  tool.actionLog && tool.actionLog.trim() !== ''
                );

                // Prompt Bank progress is a replaceable status line. Keep only
                // the newest one so stale loading indicators do not remain on
                // screen and mislead the user.
                const isPromptBankProgress = isSkillScan &&
                  subStep.brief?.includes('题库生成') &&
                  !!subStep.description;

                if (isPromptBankProgress && subIndex !== latestPromptBankProgressIndex) {
                  return null;
                }
                
                // Skip ordinary status-only subSteps, but retain Prompt Bank
                // progress updates for the Skill Scan detail view.
                if (!hasActionLogTools && !isPromptBankProgress) {
                  return null;
                }
                
                // When a tool is selected, only show the sub-step that owns it
                if (selectedTool && selectedTool.step.id === step.id && selectedTool.subStepIndex !== subIndex) {
                  return null;
                }
                
                return (
                  <div key={subIndex} className="border rounded-lg p-5 bg-gray-50">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center space-x-2 min-w-0">
                        <span className="text-sm font-medium text-gray-900 truncate" title={subStep.brief}>{subStep.brief}</span>
                        <Badge variant={subStep.status === 'done' ? 'default' : 'secondary'} className="text-xs flex-shrink-0">
                          {subStep.status === 'done' ? t('mcp.status.done') : subStep.status === 'doing' ? t('mcp.status.doing') : t('mcp.status.todo')}
                        </Badge>
                      </div>
                    </div>
                    {subStep.description && (
                      <div className="text-xs text-gray-500 mb-3">
                        {subStep.description}
                      </div>
                    )}
                    {subStep.toolUsed && subStep.toolUsed.length > 0 && (
                      <div className="space-y-3">
                        {subStep.toolUsed
                          .filter(tool => tool.actionLog && tool.actionLog.trim() !== '') // Only show tools that have actionLog content
                          .map((tool, toolIndex) => {
                            const isSelected = selectedTool && 
                              selectedTool.step.id === step.id && 
                              selectedTool.subStepIndex === subIndex && 
                              selectedTool.toolIndex === toolIndex;
                            
                            // Only show the selected tool, or show all tools when nothing is selected
                            const shouldShow = isSelected || !selectedTool;
                            
                            if (!shouldShow) {
                              return null;
                            }
                            
                            const isAgentScan = currentTask?.type === 'Agent-Scan';

                            return (
                              <div key={toolIndex} className="border rounded-lg p-5 bg-white">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center space-x-2 min-w-0">
                                    {!isAgentScan && (
                                      <div className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-medium truncate">
                                        {tool.tool || tool.brief}
                                      </div>
                                    )}
                                    <span className={`text-sm text-gray-600 truncate ${isAgentScan ? 'max-w-xs' : ''}`} title={`${tool.message.action} ${tool.message.param}`}>
                                      {tool.message.action} {tool.message.param}
                                    </span>
                                    {tool.result && (
                                      <div className="text-sm text-green-600 truncate max-w-xs" title={tool.result}>
                                        {tool.result}
                                      </div>
                                    )}
                                  </div>
                                  <Badge 
                                    variant="outline" 
                                    className={`text-xs ml-2 flex-shrink-0 ${
                                      tool.status === 'done' 
                                        ? 'bg-green-50 text-green-700 border-green-200' 
                                        : tool.status === 'doing' 
                                        ? 'bg-blue-50 text-blue-700 border-blue-200' 
                                        : 'bg-gray-50 text-gray-700 border-gray-200'
                                    }`}
                                  >
                                    {tool.status === 'done' ? t('mcp.status.success') : tool.status === 'doing' ? t('mcp.status.doing') : t('mcp.status.todo')}
                                  </Badge>
                                </div>
                                {tool.actionLog && (
                                  <div className="py-4 text-sm text-gray-700 leading-relaxed">
                                    <pre className="whitespace-pre-wrap font-mono text-sm">
                                      {tool.actionLog}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
                });
              })()}
            </div>
          </div>
        )}

        {/* Progress info */}
        {/*step.status === 'doing' && (
          <div className="p-4 border-b border-gray-200 flex-shrink-0">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Execution progress</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex justify-between text-sm text-gray-600 mb-2">
                  <span>Current progress</span>
                  <span className="font-medium">{Math.round(step.progress)}%</span>
                </div>
                <Progress value={step.progress} className="h-3" />
              </CardContent>
            </Card>
          </div>
        )*/}

        {/* Execution details */}
        {step.details && (
          <div className="p-4 border-b border-gray-200 flex-shrink-0">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center">
                  <Info className="w-4 h-4 mr-2" />
                  {t('mcp.executionDetails')}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                  {step.details}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Timing info */}
        {/* <div className="p-4 flex-shrink-0">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center">
                <Calendar className="w-4 h-4 mr-2" />
                Timing info
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              {step.startTime && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Start time</span>
                  <span className="font-mono text-gray-900">
                    {formatTime(step.startTime)}
                  </span>
                </div>
              )}
              
              {step.endTime && (
                <>
                  <Separator />
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">End time</span>
                    <span className="font-mono text-gray-900">
                      {formatTime(step.endTime)}
                    </span>
                  </div>
                </>
              )}
              
              {step.startTime && (
                <>
                  <Separator />
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 flex items-center">
                      <Timer className="w-3 h-3 mr-1" />
                      Elapsed time
                    </span>
                    <span className="font-medium text-gray-900">
                      {formatDuration(step.startTime, step.endTime)}
                    </span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div> */}
        </div>
      </div>
    </TooltipProvider>
  );
};

export default McpStepDetail;
