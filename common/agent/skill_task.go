// Copyright (c) 2024-2026 Tencent Zhuque Lab. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Requirement: Any integration or derivative work must explicitly attribute
// Tencent Zhuque Lab (https://github.com/Tencent/AI-Infra-Guard) in its
// documentation or user interface, as detailed in the NOTICE file.

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Tencent/AI-Infra-Guard/common/utils"
	"github.com/Tencent/AI-Infra-Guard/internal/gologger"
	"github.com/google/uuid"
)

// SkillTask performs security auditing of Agent Skill projects.
// It mirrors the structure of McpTask but is scoped to code-mode scanning only.
type SkillTask struct {
	Server string
}

func (s *SkillTask) GetName() string {
	return TaskTypeSkillScan
}

func (s *SkillTask) Execute(ctx context.Context, request TaskRequest, callbacks TaskCallbacks) error {
	type ScanSkillRequest struct {
		Content string `json:"-"`
		Model   struct {
			Model   string `json:"model"`
			Token   string `json:"token"`
			BaseUrl string `json:"base_url"`
		} `json:"model"`
		PromptBank struct {
			Enabled               *bool `json:"enabled"`
			CasesPerVulnerability int   `json:"cases_per_vulnerability"`
		} `json:"prompt_bank"`
	}

	var params ScanSkillRequest
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return err
	}
	params.Content = request.Content
	files := request.Attachments
	promptBankEnabled := true
	if params.PromptBank.Enabled != nil {
		promptBankEnabled = *params.PromptBank.Enabled
	}
	casesPerVulnerability := params.PromptBank.CasesPerVulnerability
	if casesPerVulnerability < 1 || casesPerVulnerability > 10 {
		casesPerVulnerability = 3
	}

	// skill-scan only supports code mode: either uploaded files or a github.com URL
	transport := "code"
	if len(files) > 0 || strings.Contains(request.Content, "github.com") {
		transport = "code"
	} else {
		transport = "code"
	}

	language := request.Language
	if language == "" {
		language = "zh"
	}

	var folder string
	if transport == "code" {
		tempDir := "uploads"
		if err := os.MkdirAll(tempDir, 0755); err != nil {
			gologger.Errorf("%s: %v", "createTempDir", err)
			return err
		}
		if len(files) > 0 {
			for _, file := range files {
				ext := ""
				supports := []string{".zip", ".tar.gz", ".tgz", ".whl"}
				for _, support := range supports {
					if strings.HasSuffix(file, support) {
						ext = support
						break
					}
				}
				if ext == "" {
					gologger.Errorln("Unsupported file type", strings.Join(supports, ","))
					continue
				}

				fileName := filepath.Join(tempDir, fmt.Sprintf("tmp-%d%s", time.Now().UnixMicro(), ext))
				err := utils.DownloadFile(s.Server, request.SessionId, file, fileName)
				if err != nil {
					return fmt.Errorf("download failed: %v", err)
				}
				extractPath, _ := filepath.Abs(filepath.Join(tempDir, fmt.Sprintf("tmp-%d", time.Now().UnixMicro())))
				switch ext {
				case ".zip", ".whl":
					err = utils.ExtractZipFile(fileName, extractPath)
				case ".tgz", ".tar.gz":
					err = utils.ExtractTGZ(fileName, extractPath)
				default:
					return errors.New("Unsupported file type: " + strings.Join(supports, ","))
				}
				if err != nil {
					return errors.New(fmt.Sprintf("extract failed: %v", err))
				}
				folder = extractPath
			}
		} else {
			extractPath, _ := filepath.Abs(filepath.Join(tempDir, fmt.Sprintf("tmp-%d", time.Now().UnixMicro())))
			err := utils.GitClone(params.Content, extractPath, 10*time.Minute)
			if err != nil {
				return fmt.Errorf("clone failed: %v", err)
			}
			folder = extractPath
		}

		if info, err := os.Stat(folder); os.IsNotExist(err) || !info.IsDir() {
			return fmt.Errorf("folder does not exist or is not a directory: %s", folder)
		}
	}

	var argv []string = make([]string, 0)
	argv = append(argv, "run", "--no-project", "main.py")
	argv = append(argv, "--model", params.Model.Model)
	argv = append(argv, "--base_url", params.Model.BaseUrl)
	argv = append(argv, "--api_key", params.Model.Token)
	argv = append(argv, "--prompt", params.Content)
	argv = append(argv, "--debug")
	argv = append(argv, "--aig-mode")
	argv = append(argv, "--language", language)

	argv = append(argv, "--repo", folder)

	var taskTitles []string
	if language == "en" {
		taskTitles = []string{
			"Info Collection",
			"Code Audit",
			"Vulnerability Review",
		}
		if promptBankEnabled {
			taskTitles = append(taskTitles, "Prompt Bank Generation")
		}
	} else {
		taskTitles = []string{
			"信息收集",
			"代码审计",
			"漏洞整理",
		}
		if promptBankEnabled {
			taskTitles = append(taskTitles, "题库生成")
		}
	}

	var tasks []SubTask
	for i, title := range taskTitles {
		tasks = append(tasks, CreateSubTask(SubTaskStatusTodo, title, 0, strconv.Itoa(i+1)))
	}
	callbacks.PlanUpdateCallback(tasks)
	config := CmdConfig{
		StatusId:              "",
		DeferResultCompletion: promptBankEnabled,
	}
	skillScanDir, err := utils.ResolveSkillScanDir()
	if err != nil {
		return fmt.Errorf("resolve skill-scan directory: %v", err)
	}
	uvBin, err := utils.ResolveUvBin()
	if err != nil {
		return fmt.Errorf("resolve uv binary: %v", err)
	}
	err = utils.RunCmdWithContext(ctx, skillScanDir, uvBin, argv, func(line string) {
		ParseStdoutLine(s.Server, skillScanDir, tasks, line, callbacks, &config, false)
	})
	if err != nil {
		return err
	}
	if !promptBankEnabled {
		return nil
	}
	err = s.generatePromptBank(ctx, request, params.Model.Model, params.Model.Token, params.Model.BaseUrl,
		language, folder, casesPerVulnerability, tasks, callbacks, config.ScanResult)
	if err != nil && config.ScanResult != nil {
		// Prompt Bank is an optional post-processing stage. Preserve the completed
		// Skill Scan result even when its setup or execution fails.
		callbacks.StepStatusUpdateCallback(strconv.Itoa(len(tasks)), uuid.NewString(), AgentStatusFailed,
			"题库生成失败", err.Error())
		return s.finishPromptBankResult(request, tasks, callbacks, config.ScanResult, map[string]interface{}{
			"enabled": true,
			"status":  "failed",
			"error":   err.Error(),
		}, false)
	}
	return err
}

func (s *SkillTask) generatePromptBank(
	ctx context.Context,
	request TaskRequest,
	model string,
	apiKey string,
	baseURL string,
	language string,
	repoDir string,
	casesPerVulnerability int,
	tasks []SubTask,
	callbacks TaskCallbacks,
	scanResult map[string]interface{},
) error {
	if scanResult == nil {
		return errors.New("skill scan returned no result for prompt bank generation")
	}

	stepID := strconv.Itoa(len(tasks))
	statusID := uuid.NewString()
	callbacks.StepStatusUpdateCallback(stepID, statusID, AgentStatusRunning,
		"题库生成", "根据中高危漏洞生成并校验 Prompt 题目")

	// RunCmdWithContext changes the child process working directory to the
	// prompt-bank module. Use absolute paths so files created by the agent
	// remain addressable from that different working directory.
	tempDir, err := filepath.Abs("uploads")
	if err != nil {
		return fmt.Errorf("resolve prompt bank temp directory: %w", err)
	}
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("create prompt bank temp directory: %w", err)
	}
	inputFile, err := os.CreateTemp(tempDir, "prompt-bank-scan-*.json")
	if err != nil {
		return fmt.Errorf("create prompt bank input: %w", err)
	}
	inputPath := inputFile.Name()
	defer os.Remove(inputPath)
	if err := json.NewEncoder(inputFile).Encode(scanResult); err != nil {
		inputFile.Close()
		return fmt.Errorf("write prompt bank input: %w", err)
	}
	if err := inputFile.Close(); err != nil {
		return fmt.Errorf("close prompt bank input: %w", err)
	}

	outputFile, err := os.CreateTemp(tempDir, "prompt-bank-*.jsonl")
	if err != nil {
		return fmt.Errorf("create prompt bank output: %w", err)
	}
	outputPath := outputFile.Name()
	outputFile.Close()
	defer os.Remove(outputPath)
	summaryFile, err := os.CreateTemp(tempDir, "prompt-bank-summary-*.json")
	if err != nil {
		return fmt.Errorf("create prompt bank summary: %w", err)
	}
	summaryPath := summaryFile.Name()
	summaryFile.Close()
	defer os.Remove(summaryPath)

	promptBankDir, err := utils.ResolveSkillPromptBankDir()
	if err != nil {
		return fmt.Errorf("resolve skill-promptbank directory: %w", err)
	}
	uvBin, err := utils.ResolveUvBin()
	if err != nil {
		return fmt.Errorf("resolve uv binary: %w", err)
	}
	args := []string{
		"run", "main.py",
		"--repo", repoDir,
		"--scan-result", inputPath,
		"--output", outputPath,
		"--summary-output", summaryPath,
		"--model", model,
		"--base-url", baseURL,
		"--language", language,
		"--cases-per-vulnerability", strconv.Itoa(casesPerVulnerability),
		"--source-scan-id", request.SessionId,
	}
	extraEnv := map[string]string{}
	if apiKey != "" {
		extraEnv["AIG_SKILL_PROMPTBANK_API_KEY"] = apiKey
	}
	err = utils.RunCmdWithContextEnv(ctx, promptBankDir, uvBin, args, extraEnv, func(line string) {
		gologger.Debugf("skill-promptbank: %s", line)
		s.forwardPromptBankProgress(line, stepID, callbacks)
	})
	if err != nil {
		callbacks.StepStatusUpdateCallback(stepID, uuid.NewString(), AgentStatusFailed,
			"题库生成失败", err.Error())
		return s.finishPromptBankResult(request, tasks, callbacks, scanResult, map[string]interface{}{
			"enabled": true,
			"status":  "failed",
			"error":   err.Error(),
		}, false)
	}

	summary := map[string]interface{}{}
	if data, readErr := os.ReadFile(summaryPath); readErr == nil {
		if jsonErr := json.Unmarshal(data, &summary); jsonErr != nil {
			gologger.WithError(jsonErr).Warnln("Failed to parse prompt bank summary")
		}
	}
	callbacks.StepStatusUpdateCallback(stepID, uuid.NewString(), AgentStatusRunning,
		"题库生成", "正在上传题库文件")
	attachment := map[string]interface{}{
		"enabled": true,
		"status":  "completed",
	}
	for key, value := range summary {
		attachment[key] = value
	}
	if info, uploadErr := utils.UploadFile(s.Server, outputPath); uploadErr == nil {
		attachment["file"] = info.Data.FileUrl
		attachment["filename"] = info.Data.Filename
	} else {
		attachment["status"] = "completed_with_errors"
		attachment["upload_error"] = uploadErr.Error()
	}
	if info, uploadErr := utils.UploadFile(s.Server, summaryPath); uploadErr == nil {
		attachment["summary_file"] = info.Data.FileUrl
	} else {
		attachment["summary_upload_error"] = uploadErr.Error()
	}
	if summaryStatus, ok := summary["status"].(string); ok && summaryStatus != "" && summaryStatus != "completed" {
		attachment["status"] = summaryStatus
	}
	if _, ok := attachment["upload_error"]; ok {
		attachment["status"] = "completed_with_errors"
	}
	if _, ok := attachment["summary_upload_error"]; ok && attachment["status"] == "completed" {
		attachment["status"] = "completed_with_errors"
	}
	validCaseCount := 0.0
	if value, ok := attachment["valid_case_count"].(float64); ok {
		validCaseCount = value
	}
	noVulnerabilities := summary["reason"] == "no_vulnerabilities"
	promptBankSucceeded := noVulnerabilities || (validCaseCount > 0 && attachment["status"] != "failed")
	brief := "题库生成完成"
	if !promptBankSucceeded {
		brief = "题库生成失败"
	} else if attachment["status"] != "completed" {
		brief = "题库生成完成（存在失败项）"
	}
	finalStatus := AgentStatusCompleted
	if !promptBankSucceeded {
		finalStatus = AgentStatusFailed
	}
	callbacks.StepStatusUpdateCallback(stepID, uuid.NewString(), finalStatus,
		brief, fmt.Sprintf("生成 %v 条有效题目", attachment["valid_case_count"]))
	return s.finishPromptBankResult(request, tasks, callbacks, scanResult, map[string]interface{}(attachment), promptBankSucceeded)
}

func (s *SkillTask) forwardPromptBankProgress(line, stepID string, callbacks TaskCallbacks) {
	var event struct {
		Type            string `json:"type"`
		Stage           string `json:"stage"`
		Message         string `json:"message"`
		Current         *int   `json:"current"`
		Total           *int   `json:"total"`
		ValidCaseCount  *int   `json:"valid_case_count"`
		FailedCaseCount *int   `json:"failed_case_count"`
	}
	if err := json.Unmarshal([]byte(line), &event); err != nil || event.Type != "prompt_bank_progress" {
		return
	}
	if event.Stage != "preparing" && event.Stage != "generating" && event.Stage != "validating" && event.Stage != "uploading" {
		return
	}
	message := event.Message
	if message == "" {
		message = "题库生成中"
	}
	counts := make([]string, 0, 2)
	if event.Current != nil && event.Total != nil {
		counts = append(counts, fmt.Sprintf("漏洞 %d/%d", *event.Current, *event.Total))
	}
	if event.ValidCaseCount != nil {
		counts = append(counts, fmt.Sprintf("有效题目 %d", *event.ValidCaseCount))
	}
	if event.FailedCaseCount != nil {
		counts = append(counts, fmt.Sprintf("失败题目 %d", *event.FailedCaseCount))
	}
	if len(counts) > 0 {
		message += "（" + strings.Join(counts, "，") + "）"
	}
	callbacks.StepStatusUpdateCallback(stepID, uuid.NewString(), AgentStatusRunning, "题库生成", message)
}

func (s *SkillTask) finishPromptBankResult(
	request TaskRequest,
	tasks []SubTask,
	callbacks TaskCallbacks,
	scanResult map[string]interface{},
	promptBank map[string]interface{},
	promptBankSucceeded bool,
) error {
	finalResult := make(map[string]interface{}, len(scanResult)+1)
	for key, value := range scanResult {
		finalResult[key] = value
	}
	finalResult["prompt_bank"] = promptBank
	for i := range tasks {
		if i == len(tasks)-1 && !promptBankSucceeded {
			tasks[i].Status = SubTaskStatusFailed
			continue
		}
		tasks[i].Status = SubTaskStatusDone
	}
	callbacks.PlanUpdateCallback(tasks)
	callbacks.ResultCallback(finalResult)
	return nil
}
