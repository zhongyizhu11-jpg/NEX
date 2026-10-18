import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  LINK_WIZARD_GOAL_LABELS,
  LINK_WIZARD_GOALS,
  LINK_WIZARD_PLACE_LABELS,
  LINK_WIZARD_PLACES,
  linkWizardAdvice,
  type LinkWizardAction,
  type LinkWizardGoal,
  type LinkWizardPlace,
} from "@shared/linkWizard";
import { LinkSpreadPicker } from "./LinkSpreadPicker";

/*
  「按目标新建」：先问要什么、多出来的机器在哪一段，再说该建哪一种（shared/linkWizard.ts），
  点「去新建」打开那个新建框，能预先填的（出口策略、中转方式、NEX 协议）替用户填好。
*/
export function LinkWizardDialog({
  open,
  onOpenChange,
  onCreate,
  forwardXAvailable,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (action: LinkWizardAction) => void;
  /** NEX 隧道协议被停用时，要 NEX 的建议写明用不了。 */
  forwardXAvailable: boolean;
}) {
  const [goal, setGoal] = useState<LinkWizardGoal>("stable");
  const [place, setPlace] = useState<LinkWizardPlace>("entry");
  const advice = linkWizardAdvice(goal, place);
  const blocked = advice.action?.type === "tunnel" && advice.action.needsForwardX && !forwardXAvailable;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>按目标新建</DialogTitle>
          <DialogDescription>说说想要什么、多出来的机器在哪，面板告诉你该建哪一种。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">想要什么</p>
            <LinkSpreadPicker
              value={goal}
              options={LINK_WIZARD_GOALS}
              labels={LINK_WIZARD_GOAL_LABELS}
              onChange={setGoal}
              ariaLabel="想要什么"
              hint={LINK_WIZARD_GOAL_LABELS[goal].hint}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">多出来的机器在哪一段</p>
            <LinkSpreadPicker
              value={place}
              options={LINK_WIZARD_PLACES}
              labels={LINK_WIZARD_PLACE_LABELS}
              onChange={setPlace}
              ariaLabel="多出来的机器在哪一段"
              hint={LINK_WIZARD_PLACE_LABELS[place].hint}
            />
          </div>
          <div className="space-y-1 rounded-md border bg-muted/30 p-3" aria-live="polite">
            <p className="text-sm font-semibold">{advice.title}</p>
            <p className="text-xs leading-5 text-muted-foreground">{advice.explain}</p>
            {advice.next ? <p className="text-xs leading-5">{advice.next}</p> : null}
            {blocked ? <p className="text-xs leading-5 text-[var(--fx-warn-text)]">NEX 隧道协议在系统设置里停用了，要先打开才能建。</p> : null}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          {advice.action ? (
            <Button
              type="button"
              disabled={blocked}
              onClick={() => {
                if (!advice.action) return;
                onOpenChange(false);
                onCreate(advice.action);
              }}
            >
              去新建
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
